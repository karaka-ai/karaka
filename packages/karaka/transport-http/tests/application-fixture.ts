import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent, type AgentHandle, type AgentSetup, type AgentOptions, type AgentFactory } from '@deepseek-ai/dsh-agent'
import AgentPresetRegistry from '@deepseek-ai/dsh-agent-preset-registry'
import LlmRuntime, { type UserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, type SessionEvent, type SessionHeader, type SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import { ApplicationId, KarakaIdentity, TenantId, UserId, sameOwner, IdentityError, type ApplicationOwner } from '@karaka-ai/identity'
import { onTestFinished, vi, type Mock } from 'vitest'
import { ApplicationChatController } from '../src/application.ts'

export const owner: ApplicationOwner = {
  applicationId: ApplicationId('app'), tenantId: TenantId('tenant'), userId: UserId('user'),
}

interface ApplicationFixture {
  ctx: Context
  controller: ApplicationChatController | undefined
  owners: Map<SessionId, ApplicationOwner>
  headers: Map<SessionId, SessionHeader>
  events: Map<SessionId, SessionEvent[]>
  handles: Map<SessionId, AgentHandle>
  followups: Map<SessionId, Mock<(message: UserMessage) => void>>
  cancellations: Map<SessionId, Mock>
  disposals: Map<SessionId, Mock<() => Promise<void>>>
  identity: {
    withChatLock: Mock<(id: SessionId, operation: () => Promise<unknown>) => Promise<unknown>>
    reserve: Mock<(id: SessionId, claimed: ApplicationOwner) => Promise<'existing' | 'create'>>
    bind: Mock<(session: Session, claimed: ApplicationOwner) => Promise<void>>
    authorize: Mock<(id: SessionId, claimed: ApplicationOwner) => Promise<SessionHeader>>
    authorizeSession: Mock<(session: Session, claimed: ApplicationOwner) => Promise<void>>
    markReady: Mock<(session: Session, claimed: ApplicationOwner) => Promise<void>>
    ownerOf: Mock<(session: Session) => Promise<ApplicationOwner | undefined>>
  }
  factory: { createAgent: Mock<AgentFactory['createAgent']>; resume: Mock<AgentFactory['resume']> }
  presets: {
    list: Mock<() => Promise<{ id: string; name?: string; description?: string; broken?: string }[]>>
    resolve: Mock<(id: string) => Promise<{ id: string }>>
    mount: Mock<(ctx: Context, id: string) => Promise<void>>
  }
  removePresets: () => void
  llm: {
    listProviders: Mock<() => { id: string }[]>
    resolveModelInfo: Mock<() => Promise<{ inputModalities?: string[] }>>
    resolveCallConfig: Mock<(request: ModelRequest) => Promise<ModelRequest>>
  }
  observed: Mock
  observeSession: Mock<(id: SessionId) => Promise<{ events: SessionEvent[]; [Symbol.dispose]: Mock }>>
}

interface ModelRequest { provider: string; model: string; reasoningEffort?: string }

export async function applicationFixture(mountController = true): Promise<ApplicationFixture> {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  const owners = new Map<SessionId, ApplicationOwner>()
  const headers = new Map<SessionId, SessionHeader>()
  const events = new Map<SessionId, SessionEvent[]>()
  const handles = new Map<SessionId, AgentHandle>()
  const followups: ApplicationFixture['followups'] = new Map()
  const cancellations: ApplicationFixture['cancellations'] = new Map()
  const disposals: ApplicationFixture['disposals'] = new Map()
  ctx.on('session/event', (session, event) => {
    const log = events.get(session.id) ?? []
    log.push(event)
    events.set(session.id, log)
  }, { global: true })
  function authorize(id: SessionId, claimed: ApplicationOwner) {
    const actual = owners.get(id)
    const header = headers.get(id)
    if (actual === undefined || header === undefined || !sameOwner(actual, claimed)) throw new IdentityError('forbidden', 'foreign chat')
    return header
  }
  const identity = {
    withChatLock: vi.fn(async (_id: SessionId, operation: () => Promise<unknown>) => operation()),
    reserve: vi.fn(async (id: SessionId, claimed: ApplicationOwner) => {
      if (headers.has(id)) { authorize(id, claimed); return 'existing' as const }
      owners.set(id, claimed)
      return 'create' as const
    }),
    bind: vi.fn(async (session: Agent['session'], claimed: ApplicationOwner) => {
      headers.set(session.id, session.header)
      authorize(session.id, claimed)
    }),
    authorize: vi.fn(async (id: SessionId, claimed: ApplicationOwner) => authorize(id, claimed)),
    authorizeSession: vi.fn(async (session: Agent['session'], claimed: ApplicationOwner) => { authorize(session.id, claimed) }),
    markReady: vi.fn(async (session: Agent['session'], claimed: ApplicationOwner) => { authorize(session.id, claimed) }),
    ownerOf: vi.fn(async (session: Agent['session']) => owners.get(session.id)),
  }
  // This fixture isolates controller orchestration; durable authority has its own storage tests.
  ctx.provide('karakaIdentity', Object.setPrototypeOf(identity, KarakaIdentity.prototype) as KarakaIdentity)
  const presets = {
    list: vi.fn(async (): Promise<{ id: string; name?: string; description?: string; broken?: string }[]> => [
      { id: 'main', name: 'Main' }, { id: 'plain' }, { id: 'broken', broken: 'missing file' },
    ]),
    resolve: vi.fn(async (id: string) => ({ id })),
    mount: vi.fn(async (_ctx: Context, _id: string) => {}),
  }
  const removePresets = ctx.provide('agentPresets', Object.setPrototypeOf(presets, AgentPresetRegistry.prototype) as AgentPresetRegistry)
  const defaultSelection = { provider: 'mock', model: 'chat' }
  ctx.provide('agentDefaultModel', { currentSelection: () => defaultSelection } as typeof ctx.agentDefaultModel)
  const llm = {
    listProviders: vi.fn(() => [{ id: 'mock' }]),
    resolveModelInfo: vi.fn(async (): Promise<{ inputModalities?: string[] }> => ({ inputModalities: ['text', 'image'] })),
    resolveCallConfig: vi.fn(async (request: { provider: string; model: string; reasoningEffort?: string }) => request),
  }
  ctx.provide('llm', Object.setPrototypeOf(llm, LlmRuntime.prototype) as LlmRuntime)
  const observed = vi.fn()
  const observeSession = vi.fn(async (id: SessionId) => ({ events: [...(events.get(id) ?? [])], [Symbol.dispose]: observed }))
  const sessionQuery = { observeSession }
  ctx.provide('sessionQuery', Object.setPrototypeOf(sessionQuery, SessionQueryEngine.prototype) as SessionQueryEngine)
  async function make(id: SessionId, setup: AgentSetup | undefined, options: AgentOptions = {}, header?: SessionHeader) {
    const session = ctx.sessions.get(id) ?? ctx.sessions.create(id, { meta: header ?? { agentPreset: 'main' } })
    const followup = vi.fn((message: UserMessage) => { session.append('user/message', message, { surfaceOp: 'append' }) })
    const cancel = vi.fn()
    const partialAgent: Pick<Agent, 'id' | 'session' | 'ctx' | 'options' | 'followup' | 'cancel'> = {
      id, session, ctx: ctx.extend(), options, followup, cancel,
    }
    const agent = partialAgent as Agent
    followups.set(id, followup)
    cancellations.set(id, cancel)
    await setup?.(agent.ctx, agent)
    const unregister = ctx.agents.register(agent)
    const handle = { agent, dispose: vi.fn(async () => { await unregister() }) }
    handles.set(id, handle)
    disposals.set(id, handle.dispose)
    return handle
  }
  const factory = {
    createAgent: vi.fn(async (_ctx: Context, options: Parameters<typeof ctx.agents.create>[0]) => make(
      options.sessionId, options.setup, options.agentOptions,
      { ...Session.create(options.sessionId).header, ...options.meta },
    )),
    resume: vi.fn(async (_ctx: Context, options: Parameters<typeof ctx.agents.resume>[0]) => make(
      options.resumeSessionId, options.setup, options.agentOptions, headers.get(options.resumeSessionId),
    )),
  }
  ctx.agents.setFactory(factory)
  const controller = mountController ? new ApplicationChatController(ctx) : undefined
  return { ctx, controller, identity, owners, headers, events, handles, factory, presets, removePresets, llm, observed,
    observeSession, followups, cancellations, disposals }
}
