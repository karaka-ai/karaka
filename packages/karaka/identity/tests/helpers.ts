import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId, type SessionHeader } from '@deepseek-ai/dsh-session'
import SessionPersistence, { SessionPersistenceRevision } from '@deepseek-ai/dsh-session-persistence'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { onTestFinished } from 'vitest'
import { KarakaIdentity, ApplicationId, TenantId, UserId, type ApplicationOwner } from '../src/index.ts'
import { identityDomain } from '../src/records.ts'

export const owner: ApplicationOwner = {
  applicationId: ApplicationId('app'), tenantId: TenantId('tenant'), userId: UserId('user'),
}

export async function fixture(provideIdentity = true) {
  const root = await mkdtemp(join(tmpdir(), 'karaka-identity-'))
  const ctx = new Context()
  const backend = new JsonStorageBackend(root)
  const resources: { facility?: DomainFacility } = {}
  onTestFinished(async () => {
    try {
      await resources.facility?.closeAll()
    } finally {
      try { await backend.close() } finally {
        try { await ctx.fiber.dispose() } finally { await rm(root, { recursive: true, force: true }) }
      }
    }
  })
  await ctx.plugin(Storage)
  await ctx.plugin(SessionStore)
  ctx.effect(() => ctx.storage.backend.register('authority-test', backend))
  const stored = new Map<SessionId, SessionHeader>()
  const snapshot = (header: SessionHeader) => ({ header, revision: SessionPersistenceRevision('fixture') })
  // Authority observes metadata only; persistence writes belong to the flush listener below.
  const persistence = {
    list: async () => [...stored.values()].map(snapshot),
    stat: async (id: SessionId) => {
      const header = stored.get(id)
      return header === undefined ? undefined : snapshot(header)
    },
  }
  ctx.provide('sessionPersistence', Object.setPrototypeOf(persistence, SessionPersistence.prototype) as SessionPersistence)
  ctx.on('session/flush', async (session) => { stored.set(session.id, session.header) })
  const facility = new DomainFacility(ctx, { backend: 'authority-test' })
  resources.facility = facility
  const domain = await facility.open(identityDomain)
  const authority = new KarakaIdentity(ctx, domain)
  await authority.initialize()
  async function create(id = SessionId('chat'), claimed = owner) {
    await authority.reserve(id, claimed)
    const session = ctx.sessions.create(id)
    await authority.bind(session, claimed)
    await authority.markReady(session, claimed)
    return session
  }
  if (provideIdentity) ctx.provide('karakaIdentity', authority)
  return { root, ctx, authority, domain, stored, create }
}
