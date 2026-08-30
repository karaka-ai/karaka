import { Service, type Context } from '@karaka/cordis'
import type { EntitlementAccount, SpendAmount } from '@karaka/entitlement'

declare module '@karaka/cordis' {
  interface Context {
    agentRuntime: AgentRuntimeService
    agentModels: AgentModelsService
  }
}

/** Minimal descriptor contributed by an agent plugin. */
export interface AgentDescriptor {
  readonly id: string
  readonly prompt: string
  readonly model: string
}

/** Text message exchanged with a model provider. */
export interface ModelMessage {
  readonly role: 'system' | 'user' | 'assistant'
  readonly content: string
}

/** Provider-neutral input for one model generation. */
export interface ModelRequest {
  readonly agentId: string
  readonly messages: readonly ModelMessage[]
}

/** Model implementation contributed by a provider plugin. */
export interface ModelProvider {
  readonly id: string
  /** Omit only when this provider never reports spend. */
  readonly spendUnit?: string
  generate(request: Readonly<ModelRequest>): Promise<ModelGeneration>
}

/** Provider-neutral model output and optional actual spend. */
export interface ModelGeneration {
  readonly message: ModelMessage
  readonly spend?: SpendAmount
}

/** Model providers visible inside one native Cordis service scope. */
export class AgentModelsService extends Service {
  static readonly provide = 'agentModels'

  private readonly providers = new Map<string, ModelProvider>()

  constructor(ctx: Context) {
    super(ctx, AgentModelsService.provide)
  }

  /** Register a model provider until the contributing plugin unloads. */
  register(provider: ModelProvider) {
    const id = requireText(provider.id, 'model ID')
    if (provider.spendUnit !== undefined) requireText(provider.spendUnit, 'model spend unit')

    return this.ctx.effect(() => {
      if (this.providers.has(id)) throw new Error(`model "${id}" is already registered`)
      this.providers.set(id, provider)
      return () => {
        if (this.providers.get(id) === provider) this.providers.delete(id)
      }
    }, `agentModels.register(${JSON.stringify(id)})`)
  }

  /** Resolve one provider from this Cordis service scope. */
  resolve(id: string): ModelProvider | undefined {
    return this.providers.get(id)
  }

  /** List model IDs from this Cordis service scope. */
  list(): readonly string[] {
    return [...this.providers.keys()]
  }
}

/** Input for the initial single-turn Agent Runtime slice. */
export interface AgentRunRequest {
  readonly agentId: string
  readonly message: string
  /** Overall entitlement account. Required only for metered models. */
  readonly entitlementAccount?: string
}

/** Start a durable chat through the installed session plugin. */
export interface AgentChatStartRequest {
  readonly agentId: string
  readonly message: string
  readonly persist: true
}

/** Resume a durable chat without accepting caller-selected runtime state. */
export interface AgentChatResumeRequest {
  readonly chatId: string
  readonly message: string
}

export type AgentRuntimeRequest = AgentRunRequest | AgentChatStartRequest | AgentChatResumeRequest

/** Output from one single-turn agent run. */
export interface AgentRunResult {
  readonly agentId: string
  readonly model: string
  readonly message: ModelMessage
}

/** One durable chat turn and its opaque locator. */
export interface AgentChatRunResult extends AgentRunResult {
  readonly chatId: string
}

/** Canonical identity stored as chat ownership data. */
export interface AgentSessionOwner {
  readonly tenantId: string
  readonly subject: string
}

/** Durable state restored by an Agent Runtime session plugin. */
export interface AgentSession {
  readonly id: string
  readonly owner: AgentSessionOwner
  readonly agentId: string
  readonly entitlementAccount: string
  readonly messages: readonly ModelMessage[]
  readonly version: number
}

/** Select a new or existing durable session without exposing mutable state. */
export type AgentSessionOpenRequest =
  | { readonly agentId: string }
  | { readonly chatId: string }

/** One session capability bound for the complete durable turn. */
export interface AgentSessionLease {
  readonly session: AgentSession
  commit(messages: readonly ModelMessage[]): Promise<AgentSession>
}

/** Session behavior contributed by an ordinary Agent Runtime plugin. */
export interface AgentSessionProvider {
  readonly name: string
  withSession<T>(
    request: Readonly<AgentSessionOpenRequest>,
    operation: (session: AgentSessionLease) => T | Promise<T>,
  ): Promise<T>
}

/** Stable Agent Runtime failures independent of model implementations. */
export type AgentRuntimeErrorCode =
  | 'INVALID_REQUEST'
  | 'UNKNOWN_AGENT'
  | 'UNKNOWN_MODEL'
  | 'SESSION_UNAVAILABLE'
  | 'CHAT_NOT_FOUND'
  | 'SESSION_CONFLICT'
  | 'INVALID_SESSION'
  | 'INVALID_MODEL_RESPONSE'

/** Provider-neutral Agent Runtime failure. */
export class AgentRuntimeError extends Error {
  override readonly name = 'AgentRuntimeError'

  constructor(readonly code: AgentRuntimeErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
  }
}

/** Registry and single-turn coordinator for Agent Runtime contributions. */
export class AgentRuntimeService extends Service {
  static inject = ['entitlement']

  private readonly agents = new Map<string, RegisteredAgent>()
  private sessionProvider: RegisteredSessionProvider | undefined

  constructor(ctx: Context) {
    super(ctx, 'agentRuntime')
    new AgentModelsService(ctx)
  }

  /** Register an agent descriptor until the contributing plugin unloads. */
  registerAgent(definition: Readonly<AgentDescriptor>, models: AgentModelsService) {
    const agent = Object.freeze({
      id: requireText(definition.id, 'agent ID'),
      prompt: requireText(definition.prompt, 'agent prompt'),
      model: requireText(definition.model, 'agent model'),
    })
    if (!models || typeof models.resolve !== 'function') {
      throw new TypeError('agent models service is required')
    }
    const registration: RegisteredAgent = Object.freeze({
      definition: agent,
      resolveModel: (id: string) => models.resolve(id),
    })

    return this.ctx.effect(() => {
      if (this.agents.has(agent.id)) throw new Error(`agent "${agent.id}" is already registered`)
      this.agents.set(agent.id, registration)
      return () => {
        if (this.agents.get(agent.id) === registration) this.agents.delete(agent.id)
      }
    }, `agentRuntime.registerAgent(${JSON.stringify(agent.id)})`)
  }

  /** Register session behavior until the contributing plugin unloads. */
  registerSessionProvider(provider: AgentSessionProvider) {
    const name = requireText(provider.name, 'session provider name')
    const registration: RegisteredSessionProvider = {
      name,
      implementation: provider,
      operations: 0,
      active: true,
    }

    return this.ctx.effect(() => {
      if (this.sessionProvider) {
        throw new Error(`agent session provider "${this.sessionProvider.name}" is already registered`)
      }
      this.sessionProvider = registration

      return async () => {
        if (this.sessionProvider === registration) this.sessionProvider = undefined
        registration.active = false
        if (registration.operations) {
          await new Promise<void>(resolve => {
            registration.resolveDrained = resolve
          })
        }
      }
    }, `agentRuntime.registerSessionProvider(${JSON.stringify(name)})`)
  }

  /** List globally addressable agent descriptors. */
  listAgents(): readonly AgentDescriptor[] {
    return [...this.agents.values()].map(registration => registration.definition)
  }

  /** List model IDs from the caller's native Cordis model scope. */
  listModels(): readonly string[] {
    return this.ctx.agentModels.list()
  }

  /** Resolve the current agent graph and execute one transient or durable text turn. */
  run(request: Readonly<AgentRunRequest>): Promise<AgentRunResult>
  run(request: Readonly<AgentChatStartRequest | AgentChatResumeRequest>): Promise<AgentChatRunResult>
  run(request: Readonly<AgentRuntimeRequest>): Promise<AgentRunResult | AgentChatRunResult>
  async run(request: Readonly<AgentRuntimeRequest>): Promise<AgentRunResult | AgentChatRunResult> {
    if (isResumeRequest(request)) return this.resumeChat(request)
    if (isPersistedStartRequest(request)) return this.startChat(request)
    return this.runTransient(request)
  }

  private async runTransient(request: Readonly<AgentRunRequest>): Promise<AgentRunResult> {
    const agentId = requireRequestText(request?.agentId, 'agent ID')
    const message = requireRequestText(request?.message, 'message')
    return (await this.generateTurn(agentId, message, request.entitlementAccount, [])).result
  }

  private async startChat(request: Readonly<AgentChatStartRequest>): Promise<AgentChatRunResult> {
    const agentId = requireRequestText(request.agentId, 'agent ID')
    const message = requireRequestText(request.message, 'message')
    this.resolveAgent(agentId)

    return this.withSessionProvider(async provider => {
      return provider.withSession({ agentId }, async lease => {
        const session = validateSession(lease.session, { agentId, messages: [] })
        return this.runSessionTurn(lease, session, message)
      })
    })
  }

  private async resumeChat(request: Readonly<AgentChatResumeRequest>): Promise<AgentChatRunResult> {
    const chatId = requireRequestText(request.chatId, 'chat ID')
    const message = requireRequestText(request.message, 'message')

    return this.withSessionProvider(async provider => {
      return provider.withSession({ chatId }, async lease => {
        const session = validateSession(lease.session, { id: chatId })
        return this.runSessionTurn(lease, session, message)
      })
    })
  }

  private async runSessionTurn(
    lease: AgentSessionLease,
    session: AgentSession,
    message: string,
  ): Promise<AgentChatRunResult> {
    const turn = await this.generateTurn(session.agentId, message, session.entitlementAccount, session.messages)
    const saved = await lease.commit(turn.messages)
    validateSession(saved, {
      id: session.id,
      owner: session.owner,
      agentId: session.agentId,
      entitlementAccount: session.entitlementAccount,
      messages: turn.messages,
      version: session.version + 1,
    })
    return Object.freeze({ chatId: session.id, ...turn.result })
  }

  private async generateTurn(
    agentId: string,
    message: string,
    requestedEntitlementAccount: string | undefined,
    history: readonly ModelMessage[],
  ) {
    const registration = this.resolveAgent(agentId)
    const agent = registration.definition
    const model = registration.resolveModel(agent.model)
    if (!model) throw new AgentRuntimeError('UNKNOWN_MODEL', `model "${agent.model}" is not registered`)

    const entitlementAccount = model.spendUnit === undefined
      ? undefined
      : requireRequestText(requestedEntitlementAccount, 'entitlement account')
    const messages: readonly ModelMessage[] = Object.freeze([
      Object.freeze({ role: 'system' as const, content: agent.prompt }),
      ...conversationMessages(history),
      Object.freeze({ role: 'user' as const, content: message }),
    ])
    const generate = async (entitlement?: EntitlementAccount) => {
      const response = await model.generate(Object.freeze({ agentId, messages }))
      const spend = validateModelSpend(model, response?.spend)
      if (spend) await entitlement!.recordSpend(spend)
      if (response?.message?.role !== 'assistant' || typeof response.message.content !== 'string') {
        throw new AgentRuntimeError('INVALID_MODEL_RESPONSE', `model "${agent.model}" returned an invalid response`)
      }

      const assistant = Object.freeze({ role: response.message.role, content: response.message.content })
      return Object.freeze({
        result: Object.freeze({ agentId, model: agent.model, message: assistant }),
        messages: Object.freeze([...messages, assistant]),
      })
    }

    if (model.spendUnit === undefined) return generate()
    return this.ctx.entitlement.withAccount(entitlementAccount!, async (entitlement) => {
      await entitlement.assertAvailable(model.spendUnit!)
      return generate(entitlement)
    })
  }

  private resolveAgent(agentId: string) {
    const registration = this.agents.get(agentId)
    if (!registration) throw new AgentRuntimeError('UNKNOWN_AGENT', `agent "${agentId}" is not registered`)
    return registration
  }

  private async withSessionProvider<T>(operation: (provider: AgentSessionProvider) => Promise<T>): Promise<T> {
    const registration = this.sessionProvider
    if (!registration) {
      throw new AgentRuntimeError('SESSION_UNAVAILABLE', 'no agent session provider is available')
    }
    registration.operations++
    try {
      return await operation(registration.implementation)
    } finally {
      registration.operations--
      if (!registration.active && !registration.operations) registration.resolveDrained?.()
    }
  }
}

interface RegisteredSessionProvider {
  readonly name: string
  readonly implementation: AgentSessionProvider
  operations: number
  active: boolean
  resolveDrained?: () => void
}

interface RegisteredAgent {
  readonly definition: AgentDescriptor
  readonly resolveModel: (id: string) => ModelProvider | undefined
}

interface ExpectedSession {
  readonly id?: string
  readonly owner?: AgentSessionOwner
  readonly agentId?: string
  readonly entitlementAccount?: string
  readonly messages?: readonly ModelMessage[]
  readonly version?: number
}

function isResumeRequest(request: Readonly<AgentRuntimeRequest>): request is AgentChatResumeRequest {
  if (!request || typeof request !== 'object' || !Object.hasOwn(request, 'chatId')) return false
  const supplied = request as AgentChatResumeRequest & Partial<AgentChatStartRequest & AgentRunRequest>
  if (supplied.agentId !== undefined || supplied.entitlementAccount !== undefined || supplied.persist !== undefined) {
    throw new AgentRuntimeError('INVALID_REQUEST', 'a resumed chat accepts only chat ID and message')
  }
  return true
}

function isPersistedStartRequest(
  request: Readonly<AgentRuntimeRequest>,
): request is AgentChatStartRequest {
  if (!request || typeof request !== 'object' || !Object.hasOwn(request, 'persist')) return false
  const supplied = request as AgentChatStartRequest & Partial<AgentRunRequest & AgentChatResumeRequest>
  if (supplied.persist !== true || supplied.chatId !== undefined || supplied.entitlementAccount !== undefined) {
    throw new AgentRuntimeError('INVALID_REQUEST', 'a new persisted chat accepts only agent ID and message')
  }
  return true
}

function validateSession(session: AgentSession, expected: ExpectedSession): AgentSession {
  try {
    const id = requireText(session?.id, 'chat ID')
    const owner = Object.freeze({
      tenantId: requireText(session?.owner?.tenantId, 'session tenant ID'),
      subject: requireText(session?.owner?.subject, 'session subject'),
    })
    const agentId = requireText(session?.agentId, 'session agent ID')
    const entitlementAccount = requireText(session?.entitlementAccount, 'session entitlement account')
    if (!Number.isSafeInteger(session?.version) || session.version < 1) {
      throw new TypeError('session version must be a positive safe integer')
    }
    if (!Array.isArray(session?.messages)) throw new TypeError('session messages must be an array')
    const messages = Object.freeze(session.messages.map((message, index) => {
      if (
        !message
        || !['system', 'user', 'assistant'].includes(message.role)
        || typeof message.content !== 'string'
        || (message.role === 'system' && index !== 0)
      ) {
        throw new TypeError('session contains an invalid model message')
      }
      return Object.freeze({ role: message.role, content: message.content })
    }))
    if (
      (expected.id !== undefined && id !== expected.id)
      || (expected.owner !== undefined && !sameOwner(owner, expected.owner))
      || (expected.agentId !== undefined && agentId !== expected.agentId)
      || (expected.entitlementAccount !== undefined && entitlementAccount !== expected.entitlementAccount)
      || (expected.messages !== undefined && !sameMessages(messages, expected.messages))
      || (expected.version !== undefined && session.version !== expected.version)
    ) {
      throw new TypeError('session provider changed stable session state')
    }
    return Object.freeze({ id, owner, agentId, entitlementAccount, messages, version: session.version })
  } catch (error) {
    if (error instanceof AgentRuntimeError) throw error
    throw new AgentRuntimeError('INVALID_SESSION', 'agent session provider returned invalid state', { cause: error })
  }
}

function conversationMessages(history: readonly ModelMessage[]): readonly ModelMessage[] {
  if (!history.length) return []
  return history[0]?.role === 'system' ? history.slice(1) : history
}

function sameOwner(left: AgentSessionOwner, right: AgentSessionOwner) {
  return left.tenantId === right.tenantId && left.subject === right.subject
}

function sameMessages(left: readonly ModelMessage[], right: readonly ModelMessage[]) {
  return left.length === right.length && left.every((message, index) => {
    const expected = right[index]
    return message.role === expected?.role && message.content === expected.content
  })
}

function validateModelSpend(model: ModelProvider, spend: SpendAmount | undefined): SpendAmount | undefined {
  if (model.spendUnit === undefined) {
    if (spend === undefined) return undefined
    throw new AgentRuntimeError('INVALID_MODEL_RESPONSE', `unmetered model "${model.id}" reported spend`)
  }
  if (
    spend?.unit !== model.spendUnit
    || typeof spend.amount !== 'bigint'
    || spend.amount < 0n
  ) {
    throw new AgentRuntimeError('INVALID_MODEL_RESPONSE', `model "${model.id}" returned invalid spend`)
  }
  return Object.freeze({ unit: spend.unit, amount: spend.amount })
}

function requireText(value: unknown, label: string): string {
  if (typeof value === 'string' && value.trim()) return value
  throw new TypeError(`${label} must be a non-empty string`)
}

function requireRequestText(value: unknown, label: string): string {
  try {
    return requireText(value, label)
  } catch (error) {
    throw new AgentRuntimeError('INVALID_REQUEST', `${label} must be a non-empty string`, { cause: error })
  }
}

export default AgentRuntimeService
