/** Application-owned lineage survives the JSONL provider used by Karaka. */

import { Context } from '@deepseek-ai/cordis'
import SessionStore, { ApplicationId, SessionId, TenantId, UserId } from '@deepseek-ai/dsh-session'
import SessionPersistenceJsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
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
    const inherited = [...parent.events]
    const child = writer.sessions.fork(parent, undefined, SessionId('owned-child'))
    expect(child.header).toMatchObject({
      applicationOwner, parentSession: parent.id, seedLength: inherited.length,
    })
    expect(child.events.slice(0, inherited.length)).toEqual(inherited)
    expect(child.events.slice(inherited.length).map(({ time, ...event }) => {
      expect(typeof time).toBe('number')
      return event
    })).toEqual([{
      type: 'session/end-seed', seq: inherited.length, data: {},
    }])
    parent.append('turn/start', { turn: 2 })
    parent.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    const stored = [parent, child].map(session => ({
      meta: { delegationDepth: 0, ...structuredClone(session.header) }, events: [...session.events],
    }))
    for (const session of [parent, child]) {
      await writer.sessionPersistence.ensureMaterialized(session)
      await writer.sessions.flush(session)
    }
    await writer.fiber.dispose()

    await reader.plugin(SessionStore)
    await reader.plugin(SessionPersistenceJsonl, { root })
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
