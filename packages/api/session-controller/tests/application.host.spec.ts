import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ApplicationId, Session, SessionId, TenantId, UserId } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import { ApplicationChatController } from '../src/application.ts'
import { SessionCommandController } from '../src/commands.ts'

const owner = { applicationId: ApplicationId('billing'), tenantId: TenantId('tenant-1'), userId: UserId('user-1') }

function fixture() {
  const ctx = new Context()
  const events: unknown[] = []
  const agent = {
    id: SessionId('chat-1'),
    status: 'idle',
    inbox: { nextTurn: [], nextStep: [] },
    session: { id: SessionId('chat-1'), header: { applicationOwner: owner }, events },
    whenIdle: () => Promise.resolve(),
  }
  const agents = {
    ensureSession: vi.fn(() => Promise.resolve(agent)),
    resolveApplicationAgent: vi.fn(() => Promise.resolve({ agent })),
    pinApplication: vi.fn(() => vi.fn()),
    touchApplication: vi.fn(),
  }
  const sessions = {
    get: (id: SessionId) => id === agent.session.id ? agent.session : undefined,
    flush: vi.fn(() => Promise.resolve()),
  }
  ctx.provide('sessions', sessions as never)
  const sessionPersistence = { ensureMaterialized: vi.fn(() => Promise.resolve()) }
  ctx.provide('sessionPersistence', sessionPersistence as never)
  const commands = {
    promptApplication: vi.fn((_agent: unknown, request: { requestId: string }) => {
      events.push({
        type: 'user/message',
        data: { source: { kind: 'user', rpcId: request.requestId } },
      })
      return Promise.resolve({ accepted: true })
    }),
    cancelApplication: vi.fn(() => ({ accepted: true })),
    selectApplicationModel: vi.fn((_agent: unknown, request: { provider: string; model: string }) => Promise.resolve({
      selected: { provider: request.provider, model: request.model },
    })),
  }
  const controller = new ApplicationChatController(ctx, agents as never, commands as never)
  return { ctx, controller, agents, commands, agent, sessions, sessionPersistence }
}

describe('ApplicationChatController', () => {
  it('creates workspace-free chats with authenticated ownership', async () => {
    const { controller, agents, agent, sessionPersistence } = fixture()

    await expect(controller.create({ chatId: SessionId('chat-1'), agentId: 'support', owner }))
      .resolves.toEqual({ chatId: 'chat-1', agentId: 'support' })
    expect(agents.ensureSession).toHaveBeenCalledWith(SessionId('chat-1'), undefined, true, 'support', owner)
    expect(sessionPersistence.ensureMaterialized).toHaveBeenCalledWith(agent.session)
    expect(agents.touchApplication).toHaveBeenCalledWith(agent)
  })

  it('deduplicates persisted request ids and rejects another owner', async () => {
    const { controller, agents, commands, agent, sessions } = fixture()
    const prompt = {
      chatId: SessionId('chat-1'),
      requestId: 'request-1',
      owner,
      content: [{ type: 'text' as const, text: 'hello' }],
    }

    await expect(controller.prompt(prompt)).resolves.toEqual({ accepted: true, duplicate: false })
    expect(sessions.flush).toHaveBeenCalledWith(agent.session)
    await expect(controller.prompt(prompt)).resolves.toEqual({ accepted: true, duplicate: true })
    expect(commands.promptApplication).toHaveBeenCalledOnce()

    agent.session.header.applicationOwner = { ...owner, userId: UserId('another-user') }
    await expect(controller.prompt({ ...prompt, requestId: 'request-2' }))
      .rejects.toMatchObject({ code: 'CHAT_FORBIDDEN' })
    expect(agents.resolveApplicationAgent).toHaveBeenCalledTimes(2)
  })

  it('deduplicates a request after the loop claims its durable inbox insertion', async () => {
    const { controller, commands, agent, sessions } = fixture()
    agent.session.events.push({
      type: 'agent/inbox/spliced',
      data: {
        inserted: [{ source: { kind: 'user', rpcId: 'request-1' } }],
      },
    })

    await expect(controller.prompt({
      chatId: SessionId('chat-1'),
      requestId: 'request-1',
      owner,
      content: [{ type: 'text', text: 'retry' }],
    })).resolves.toEqual({ accepted: true, duplicate: true })
    expect(commands.promptApplication).not.toHaveBeenCalled()
    expect(sessions.flush).toHaveBeenCalledWith(agent.session)
  })

  it('retries durability before acknowledging a request whose first flush failed', async () => {
    const { controller, commands, agent, agents, sessions } = fixture()
    sessions.flush.mockRejectedValueOnce(new Error('storage unavailable'))
    const request = {
      chatId: SessionId('chat-1'),
      requestId: 'request-1',
      owner,
      content: [{ type: 'text' as const, text: 'retry me' }],
    }

    await expect(controller.prompt(request)).rejects.toThrow('storage unavailable')
    await expect(controller.prompt(request)).resolves.toEqual({ accepted: true, duplicate: true })
    expect(commands.promptApplication).toHaveBeenCalledOnce()
    expect(sessions.flush).toHaveBeenCalledTimes(2)
    expect(sessions.flush).toHaveBeenLastCalledWith(agent.session)
    expect(sessions.flush.mock.invocationCallOrder.at(-1))
      .toBeLessThan(agents.touchApplication.mock.invocationCallOrder.at(-1) as number)
  })

  it('keeps aborted admitted prompts serialized and drains them during disposal', async () => {
    const { ctx, controller, commands } = fixture()
    const gate = Promise.withResolvers<{ readonly accepted: true }>()
    commands.promptApplication.mockImplementationOnce(() => gate.promise)
    const abort = new AbortController()
    const request = {
      chatId: SessionId('chat-1'),
      requestId: 'request-1',
      owner,
      content: [{ type: 'text' as const, text: 'first' }],
    }
    const first = controller.prompt(request, abort.signal)
    await vi.waitFor(() => { expect(commands.promptApplication).toHaveBeenCalledOnce() })
    abort.abort()
    const second = controller.prompt({ ...request, requestId: 'request-2' })
    await Promise.resolve()
    expect(commands.promptApplication).toHaveBeenCalledOnce()

    let disposed = false
    const disposal = ctx.fiber.dispose().then(() => { disposed = true })
    await Promise.resolve()
    expect(disposed).toBe(false)

    gate.resolve({ accepted: true })
    await expect(first).resolves.toEqual({ accepted: true, duplicate: false })
    await expect(second).resolves.toEqual({ accepted: true, duplicate: false })
    await disposal
  })

  it('selects an application chat model without saving the deployment default', async () => {
    const ctx = new Context()
    const saveSelection = vi.fn(() => Promise.resolve())
    ctx.provide('llm', {
      resolveCallConfig: () => Promise.resolve({ provider: 'provider-b', model: 'model-b' }),
    } as never)
    ctx.provide('agentDefaultModel', { saveSelection } as never)
    const selectForNextRequest = vi.fn()
    const agents = {
      serializeImageAdmission: (_agent: Agent, operation: () => Promise<unknown>) => operation(),
      selectForNextRequest,
    }
    const commands = new SessionCommandController(ctx, agents as never, '/tmp')
    const agent = {
      id: SessionId('chat-model'),
      session: { header: { applicationOwner: owner } },
    } as Agent

    await expect(commands.selectApplicationModel(agent, {
      sessionId: agent.id,
      provider: 'provider-b',
      model: 'model-b',
    })).resolves.toEqual({ selected: { provider: 'provider-b', model: 'model-b' } })
    expect(selectForNextRequest).toHaveBeenCalledWith(agent, { provider: 'provider-b', model: 'model-b' })
    expect(saveSelection).not.toHaveBeenCalled()
  })

  it('flushes a standalone application model selection before acknowledging it', async () => {
    const { controller, agent, commands, sessions } = fixture()

    await expect(controller.selectModel({
      chatId: agent.id,
      owner,
      provider: 'provider-b',
      model: 'model-b',
    })).resolves.toEqual({ selected: { provider: 'provider-b', model: 'model-b' } })
    expect(commands.selectApplicationModel).toHaveBeenCalledWith(
      agent,
      { sessionId: agent.id, provider: 'provider-b', model: 'model-b' },
    )
    expect(sessions.flush).toHaveBeenCalledWith(agent.session)
  })

  it('follows workspace-free application Sessions without the workspace history filter', async () => {
    const ctx = new Context()
    const chatId = SessionId('chat-1')
    const session = Session.create(chatId, undefined, { version: 0, id: chatId, createdAt: 0, applicationOwner: owner })
    ctx.provide('sessions', { get: (id: SessionId) => id === chatId ? session : undefined } as never)
    const controller = new ApplicationChatController(ctx, {} as never, {} as never)
    const abort = new AbortController()
    const frames = controller.follow({ chatId, owner }, abort.signal)[Symbol.asyncIterator]()
    try {
      await expect(frames.next()).resolves.toMatchObject({
        value: { type: 'snapshot', cursor: -1, header: { applicationOwner: owner } },
      })
      const event = session.append('turn/start', { turn: 1 })
      ctx.emit('session/event', session, event)
      await expect(frames.next()).resolves.toMatchObject({ value: { type: 'event', event: { seq: 0 } } })
    } finally {
      abort.abort()
      await frames.return?.()
      await ctx.fiber.dispose()
    }
  })
})
