import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { ConnectionCaller } from '@deepseek-ai/dsh-client-connection'
import SessionStore, { ApplicationId, SessionId, TenantId, UserId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type SessionController from '../src/index.ts'
import { createSessionTestController, testSessionPersistence } from './test-remote.ts'

const roots: Context[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose())) })
const owner = { applicationId: ApplicationId('app'), tenantId: TenantId('tenant'), userId: UserId('alice') }
const chatId = SessionId('owned-chat')

async function fixture() {
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  ctx.provide('sessionPersistence', testSessionPersistence(ctx, {
    list: () => Promise.resolve([]), inspect: () => Promise.resolve(undefined),
  }) as never)
  const controller = createSessionTestController(ctx, {
    defaultModelSelection: () => ({ provider: 'fixture', model: 'fixture' }), cwd: '/tmp',
  })
  const session = ctx.sessions.create(chatId, { meta: { applicationOwner: owner } })
  const caller: ConnectionCaller = { kind: 'application', owner, expiresAt: Date.now() + 60_000 }
  const scope = (identity?: ConnectionCaller) => ctx.extend({ connectionCaller: identity }).get('sessionController') as SessionController
  return { ctx, controller, session, caller, scope }
}

describe('application Remote caller ownership', () => {
  it('uses authenticated ownership even when request objects contain another owner', async () => {
    const { controller, session, caller, scope } = await fixture()
    const remote = scope(caller)
    const signal = new AbortController().signal
    const list = vi.spyOn(controller.application, 'listAgents').mockResolvedValue([{ id: 'support', name: 'Support' }])
    const create = vi.spyOn(controller.application, 'create').mockResolvedValue({ chatId, agentId: 'support' })
    const prompt = vi.spyOn(controller.application, 'prompt').mockResolvedValue({ accepted: true, duplicate: false })
    const cancel = vi.spyOn(controller.application, 'cancel').mockResolvedValue({ accepted: true })
    const forged = { chatId, owner: { ...owner, userId: UserId('bob') } }
    const message = { ...forged, requestId: 'message', content: [{ type: 'text' as const, text: 'hello' }] }
    expect(await remote.applicationAgents(signal)).toEqual([{ id: 'support', name: 'Support' }])
    expect(list).toHaveBeenCalledWith(signal)
    expect(await remote.applicationCreate({ ...forged, agentId: 'support' }, signal)).toEqual({ chatId, agentId: 'support' })
    expect(create).toHaveBeenCalledWith({ chatId, agentId: 'support', owner }, signal)
    expect(await remote.applicationPrompt(message, signal)).toEqual({ accepted: true, duplicate: false })
    expect(prompt).toHaveBeenCalledWith({ ...message, owner }, signal)
    expect(await remote.applicationCancel(forged, signal)).toEqual({ accepted: true })
    expect(cancel).toHaveBeenCalledWith({ chatId, owner }, signal)
    session.append('turn/start', { turn: 1 })
    expect(await remote.applicationHistory(forged, signal)).toEqual(session.snapshotEvents())
    const abort = new AbortController()
    const stream = remote.applicationFollow(forged, abort.signal)[Symbol.asyncIterator]()
    try {
      expect(await stream.next()).toMatchObject({ done: false, value: { type: 'snapshot', header: { applicationOwner: owner } } })
    } finally {
      abort.abort()
      await stream.return?.()
    }
  })

  it('rejects missing, Host and expired callers before any application operation', async () => {
    const { controller, caller, scope } = await fixture()
    const signal = new AbortController().signal
    const list = vi.spyOn(controller.application, 'listAgents')
    const identities = [undefined, { kind: 'host' } as const, { ...caller, expiresAt: 0 }]
    const methods = [
      (remote: SessionController) => remote.applicationAgents(signal),
      (remote: SessionController) => remote.applicationCreate({ chatId, agentId: 'support' }, signal),
      (remote: SessionController) => remote.applicationPrompt({ chatId, requestId: 'message', content: [] }, signal),
      (remote: SessionController) => remote.applicationHistory({ chatId }, signal),
      (remote: SessionController) => remote.applicationFollow({ chatId }, signal),
      (remote: SessionController) => remote.applicationCancel({ chatId }, signal),
    ]
    for (const identity of identities) {
      for (const invoke of methods) {
        await expect(Promise.resolve().then<unknown>(() => invoke(scope(identity))))
          .rejects.toMatchObject({ code: 'gateway/forbidden' })
      }
    }
    expect(list).not.toHaveBeenCalled()
  })

  it('refuses another user’s history and follow through the application controller', async () => {
    const { caller, scope } = await fixture()
    const remote = scope({ ...caller, owner: { ...owner, userId: UserId('bob') } })
    const abort = new AbortController()
    await expect(remote.applicationHistory({ chatId }, abort.signal)).rejects.toMatchObject({ code: 'CHAT_FORBIDDEN' })
    const stream = remote.applicationFollow({ chatId }, abort.signal)[Symbol.asyncIterator]()
    try {
      await expect(stream.next()).rejects.toMatchObject({ code: 'CHAT_FORBIDDEN' })
    } finally {
      abort.abort()
      await stream.return?.()
    }
  })
})
