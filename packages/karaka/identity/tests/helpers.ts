import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId, type SessionHeader } from '@deepseek-ai/dsh-session'
import SessionPersistence, { SessionPersistenceRevision } from '@deepseek-ai/dsh-session-persistence'
import { onTestFinished, vi } from 'vitest'
import { KarakaIdentity, ApplicationId, TenantId, UserId, type ApplicationOwner } from '../src/index.ts'

export const owner: ApplicationOwner = {
  applicationId: ApplicationId('app'), tenantId: TenantId('tenant'), userId: UserId('user'),
}

export async function fixture(provideIdentity = true) {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  const stored = new Map<SessionId, SessionHeader>()
  const snapshot = (header: SessionHeader) => ({ header, revision: SessionPersistenceRevision('fixture') })
  const persistence = {
    list: vi.fn(async () => [...stored.values()].map(snapshot)),
    stat: vi.fn(async (id: SessionId) => {
      const header = stored.get(id)
      return header === undefined ? undefined : snapshot(header)
    }),
  }
  ctx.provide('sessionPersistence', Object.setPrototypeOf(persistence, SessionPersistence.prototype) as SessionPersistence)
  ctx.on('session/flush', async (session) => { stored.set(session.id, session.header) })
  const authority = new KarakaIdentity(ctx)
  onTestFinished(() => authority.close())
  async function create(id = SessionId('chat'), claimed = owner) {
    await authority.reserve(id, claimed)
    const session = ctx.sessions.create(id)
    await authority.bind(session, claimed)
    await authority.markReady(session, claimed)
    return session
  }
  if (provideIdentity) ctx.provide('karakaIdentity', authority)
  return { ctx, authority, stored, persistence, create }
}
