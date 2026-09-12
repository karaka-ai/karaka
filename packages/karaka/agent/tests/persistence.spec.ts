/** Application-owned lineage survives the JSONL provider used by Karaka. */

import { Context } from '@deepseek-ai/cordis'
import SessionStore, { ApplicationId, SessionId, SessionLogOffset, TenantId, UserId } from '@deepseek-ai/dsh-session'
import SessionPersistenceJsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import { SessionReadOnlyError } from '@deepseek-ai/dsh-session-persistence'
import { logPath } from '../../../session/session-persistence-jsonl/src/format.ts'
import { SessionObservationReader } from '@deepseek-ai/dsh-session-query/src/observation.ts'
import { ApplicationChatController } from '@deepseek-ai/dsh-api-session-controller/src/application.ts'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'

it('restores an owned parent and its exact fork prefix from JSONL after provider disposal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'karaka-jsonl-lineage-'))
  const writer = new Context()
  const reader = new Context()
  try {
    await writer.plugin(SessionStore)
    await writer.plugin(SessionPersistenceJsonl, { root })
    const applicationOwner = {
      applicationId: ApplicationId('billing'),
      tenantId: TenantId('tenant-1'),
      userId: UserId('user-1'),
    }
    const parent = writer.sessions.create(SessionId('owned-parent'), { meta: { applicationOwner } })
    parent.append('turn/start', { turn: 1 })
    parent.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const inherited = parent.snapshotEvents()
    const child = writer.sessions.fork(parent, undefined, SessionId('owned-child'))
    expect(child.header).toMatchObject({
      applicationOwner, parentSession: parent.id, isSeeded: true,
    })
    expect(child.inheritedEventCount).toBe(inherited.length)
    expect(child.snapshotEvents(SessionLogOffset(0), SessionLogOffset(inherited.length))).toEqual(inherited)
    expect(child.snapshotEvents(SessionLogOffset(inherited.length)).map(({ time, ...event }) => {
      expect(typeof time).toBe('number')
      return event
    })).toEqual([{
      type: 'session/end-seed', seq: inherited.length, data: {},
    }])
    parent.append('turn/start', { turn: 2 })
    parent.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    const stored = [parent, child].map(session => ({
      meta: { delegationDepth: 0, ...structuredClone(session.header) },
      inheritedEventCount: session.inheritedEventCount, events: session.snapshotEvents(),
    }))
    for (const item of stored) {
      const handle = await writer.sessionPersistence.create(item.meta, { inheritedEventCount: item.inheritedEventCount })
      try {
        await handle.append(item.events)
        await handle.flush()
      } finally {
        await handle.close()
      }
    }
    await writer.fiber.dispose()

    await reader.plugin(SessionStore)
    await reader.plugin(SessionPersistenceJsonl, { root })
    const observations = new SessionObservationReader(reader)
    reader.provide('sessionQuery', { observeSession: observations.read.bind(observations) } as never)
    const controller = new ApplicationChatController(reader, {} as never, {} as never)
    const backend = reader.sessionPersistence as SessionPersistenceJsonl
    const headers = await backend.list()
    expect(headers).toHaveLength(2)
    expect(headers.map(snapshot => snapshot.header)).toEqual(expect.arrayContaining(stored.map(item => item.meta)))
    const locations = stored.map(item => logPath(root, item.meta.cwd, item.meta.id, 'zstd'))
    expect(locations[0]).not.toBe(locations[1])
    for (const item of stored) {
      expect(reader.sessions.get(item.meta.id)).toBeUndefined()
      const path = logPath(root, item.meta.cwd, item.meta.id, 'zstd')
      const bytes = await readFile(path)
      expect(bytes.subarray(0, 4)).toEqual(Buffer.from([0x28, 0xb5, 0x2f, 0xfd]))
      const handle = await backend.open(item.meta.id, 'read')
      try {
        expect(handle.header).toEqual(item.meta)
        expect(handle.inheritedEventCount).toBe(item.inheritedEventCount)
        await expect(handle.read()).resolves.toEqual(item.events)
        await expect(handle.read(item.inheritedEventCount)).resolves.toEqual(item.events.slice(item.inheritedEventCount))
        await expect(handle.append([])).rejects.toBeInstanceOf(SessionReadOnlyError)
        await expect(handle.flush()).rejects.toBeInstanceOf(SessionReadOnlyError)
      } finally {
        await handle.close()
      }
      await expect(readFile(path)).resolves.toEqual(bytes)
      expect(reader.sessions.get(item.meta.id)).toBeUndefined()
      const abort = new AbortController()
      const frames = controller.follow({ chatId: item.meta.id, owner: applicationOwner }, abort.signal)
        [Symbol.asyncIterator]()
      try {
        const opening = await frames.next()
        expect(opening.value).toEqual({
          type: 'snapshot',
          header: {
            ...Object.fromEntries(Object.entries(item.meta).filter(([key]) => key !== 'isSeeded')),
            ...(item.meta.isSeeded ? { seedLength: item.inheritedEventCount } : {}),
          },
          cursor: item.events.at(-1)?.seq ?? -1,
          records: item.events.map(event => ({ type: 'event', event })),
          hasMore: false,
          projections: { asOfSeq: item.events.at(-1)?.seq ?? -1, values: {} },
        })
        expect(reader.sessions.get(item.meta.id)).toBeUndefined()
        for (const wrongOwner of [
          { ...applicationOwner, applicationId: ApplicationId('another-application') },
          { ...applicationOwner, tenantId: TenantId('another-tenant') },
          { ...applicationOwner, userId: UserId('another-user') },
        ]) {
          const denied = controller.follow({ chatId: item.meta.id, owner: wrongOwner }, abort.signal)
            [Symbol.asyncIterator]()
          try {
            await expect(denied.next()).rejects.toMatchObject({ code: 'CHAT_FORBIDDEN' })
          } finally {
            await denied.return?.()
          }
        }
      } finally {
        abort.abort()
        await frames.return?.()
      }
      await expect(readFile(path)).resolves.toEqual(bytes)
    }
  } finally {
    try {
      await writer.fiber.dispose()
    } finally {
      try {
        await reader.fiber.dispose()
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  }
})
