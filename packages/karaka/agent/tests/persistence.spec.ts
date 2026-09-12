/** Application-owned lineage survives the JSONL provider used by Karaka. */

import { Context } from '@deepseek-ai/cordis'
import SessionStore, { ApplicationId, SessionId, SessionLogOffset, TenantId, UserId } from '@deepseek-ai/dsh-session'
import SessionPersistenceJsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
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
    for (const session of [parent, child]) {
      await writer.sessionPersistence.ensureMaterialized(session)
      await writer.sessions.flush(session)
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
    expect(headers).toEqual(expect.arrayContaining(stored.map(item => item.meta)))
    const locations = stored.map(item => backend.locate(item.meta).path)
    expect(locations[0]).not.toBe(locations[1])
    for (const item of stored) {
      expect(reader.sessions.get(item.meta.id)).toBeUndefined()
      const location = backend.locate(item.meta)
      expect(location.kind).toBe('jsonl')
      expect(location.path).toMatch(/\.jsonl\.zstd$/u)
      const bytes = await readFile(location.path)
      expect(bytes.subarray(0, 4)).toEqual(Buffer.from([0x28, 0xb5, 0x2f, 0xfd]))
      const prefix = await backend.loadStored(item.meta.id)
      expect(prefix).toMatchObject(item)
      expect(prefix?.events).toEqual(item.events)
      expect(prefix?.tornMarker).toBeUndefined()
      await expect(readFile(location.path)).resolves.toEqual(bytes)
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
        const prepared = await backend.prepare(item.meta.id)
        try {
          expect(prepared.session.header).toEqual(item.meta)
          expect(prepared.session.inheritedEventCount).toBe(item.inheritedEventCount)
          expect(prepared.session.ownEvents()).toEqual([
            ...item.events.slice(item.inheritedEventCount),
            ...(item.meta.id === parent.id
              ? [expect.objectContaining({ type: 'session/end-seed', seq: 4, data: {} })]
              : []),
          ])
        } finally {
          prepared[Symbol.dispose]()
        }
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
