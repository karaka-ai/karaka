import { Service, type Context } from '@karaka/cordis'
import type { EntitlementAccount, SpendAmount } from '@karaka/entitlement'
import type { JsonValue, ToolDescriptor } from '@karaka/sdk/tool'
import type { ToolLease, ToolService } from '@karaka/tool/core'

declare module '@karaka/cordis' {
  interface Context {
    agentRuntime: AgentRuntimeService
    agentModels: AgentModelsService
  }

  interface Events {
    'karaka/ready'(): void | Promise<void>
  }
}

/** Minimal descriptor contributed by an agent plugin. */
export interface AgentDescriptor {
  readonly id: string
  readonly prompt: string
  readonly model: string
  /** Exact logical tool IDs exposed to this agent. */
  readonly tools?: readonly string[]
  /** Maximum consecutive model responses containing tool calls. Defaults to 8. */
  readonly maxToolRounds?: number
}

/** Text message exchanged with a model provider. */
export interface ModelMessage {
  readonly role: 'system' | 'user' | 'assistant'
  readonly content: string
  /** Optional provider-owned representation used for exact stateless replay. */
  readonly providerData?: ModelProviderData
}

/** JSON-safe provider state carried opaquely by Agent Runtime and Storage. */
export interface ModelProviderData {
  readonly provider: string
  readonly value: JsonValue
}

/** One validated tool request returned by a model provider. */
export interface ModelToolCall {
  readonly type: 'tool-call'
  readonly callId: string
  readonly toolId: string
  readonly input: JsonValue
  /** Optional provider-owned representation used for exact stateless replay. */
  readonly providerData?: ModelProviderData
}

/** One validated tool result supplied to the next model generation. */
export interface ModelToolResult {
  readonly type: 'tool-result'
  readonly callId: string
  readonly toolId: string
  readonly output: JsonValue
}

/** A provider-owned conversation item with no provider-neutral equivalent. */
export interface ModelProviderItem {
  readonly type: 'provider-item'
  readonly providerData: ModelProviderData
}

/** Durable, provider-neutral conversation state. */
export type ModelConversationItem = ModelMessage | ModelToolCall | ModelToolResult | ModelProviderItem

/** Ordered model output that can be supplied to a later stateless generation. */
export type ModelReplayItem = ModelMessage | ModelToolCall | ModelProviderItem

/** Provider-neutral input for one model generation. */
export interface ModelRequest {
  readonly agentId: string
  readonly messages: readonly ModelConversationItem[]
  readonly tools: readonly ToolDescriptor[]
  readonly signal?: AbortSignal
}

/** Model implementation contributed by a provider plugin. */
export interface ModelProvider {
  readonly id: string
  /** Omit only when this provider never reports spend. */
  readonly spendUnit?: string
  /** Validate a complete model-facing tool set while an agent activates. */
  validateTools?(tools: readonly ToolDescriptor[]): void
  generate(request: Readonly<ModelRequest>): Promise<ModelGeneration>
  /** Optional incremental generation path used by streaming consumers. */
  stream?(request: Readonly<ModelRequest>): AsyncIterable<ModelStreamEvent>
}

/** Provider-neutral model output and optional provider-reported spend. */
export interface ModelGeneration {
  readonly message: ModelMessage
  readonly toolCalls?: readonly ModelToolCall[]
  /** Exact ordered output for stateless replay; defaults to message then tool calls. */
  readonly replay?: readonly ModelReplayItem[]
  readonly spend?: SpendAmount
}

/** Incremental output from a streaming model provider. */
export type ModelStreamEvent =
  | { readonly type: 'text-delta', readonly delta: string }
  | { readonly type: 'completed', readonly generation: ModelGeneration }

/** Model providers visible inside one native Cordis service scope. */
export class AgentModelsService extends Service {
  static readonly provide = 'agentModels'

  private readonly providers = new Map<string, RegisteredModel>()
  private _revision = 0

  constructor(ctx: Context) {
    super(ctx, AgentModelsService.provide)
  }

  /** Register a model provider until the contributing plugin unloads. */
  register(provider: ModelProvider) {
    const id = requireText(provider.id, 'model ID')
    if (provider.spendUnit !== undefined) requireText(provider.spendUnit, 'model spend unit')

    const registration: RegisteredModel = {
      provider,
      leases: 0,
      active: true,
    }

    return this.ctx.effect(() => {
      if (this.providers.has(id)) throw new Error(`model "${id}" is already registered`)
      this.providers.set(id, registration)
      this._revision++
      return async () => {
        if (this.providers.get(id) === registration) this.providers.delete(id)
        registration.active = false
        this._revision++
        if (registration.leases) {
          await new Promise<void>(resolve => {
            registration.resolveDrained = resolve
          })
        }
      }
    }, `agentModels.register(${JSON.stringify(id)})`)
  }

  /** Resolve one provider from this Cordis service scope. */
  resolve(id: string): ModelProvider | undefined {
    return this.providers.get(id)?.provider
  }

  /** List model IDs from this Cordis service scope. */
  list(): readonly string[] {
    return [...this.providers.keys()]
  }

  /** Monotonic provider version used to refresh compiled agent definitions. */
  get revision(): number {
    return this._revision
  }

  /** Retain one provider for a complete in-flight Agent Runtime turn. */
  lease(id: string): ModelLease {
    const registration = this.providers.get(id)
    if (!registration) throw new AgentRuntimeError('UNKNOWN_MODEL', `model "${id}" is not registered`)
    registration.leases++
    let active = true
    return Object.freeze({
      provider: registration.provider,
      release: () => {
        if (!active) return
        active = false
        registration.leases--
        if (!registration.active && !registration.leases) registration.resolveDrained?.()
      },
    })
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

/** Protocol-neutral output emitted while an Agent Runtime turn is active. */
export interface AgentRuntimeTextDelta {
  readonly type: 'text-delta'
  readonly delta: string
}

export interface AgentRuntimeRunOptions {
  readonly signal?: AbortSignal
}

export type AgentRuntimeStreamOptions = AgentRuntimeRunOptions

export type AgentRuntimeEventSink = (
  event: Readonly<AgentRuntimeTextDelta>,
) => void | Promise<void>

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
  readonly messages: readonly ModelConversationItem[]
  readonly version: number
}

/** Select a new or existing durable session without exposing mutable state. */
export type AgentSessionOpenRequest =
  | { readonly agentId: string }
  | { readonly chatId: string }

/** One session capability bound for the complete durable turn. */
export interface AgentSessionLease {
  readonly session: AgentSession
  commit(messages: readonly ModelConversationItem[]): Promise<AgentSession>
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
  | 'ABORTED'
  | 'UNKNOWN_AGENT'
  | 'UNKNOWN_MODEL'
  | 'INVALID_AGENT'
  | 'TOOL_ROUND_LIMIT'
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
    ctx.on('karaka/ready', () => this.assertReady())
  }

  /** Register an agent descriptor until the contributing plugin unloads. */
  registerAgent(
    definition: Readonly<AgentDescriptor>,
    models: AgentModelsService,
    tools?: ToolService,
  ) {
    const allowedTools = definition.tools === undefined
      ? undefined
      : Object.freeze(requireToolIds(definition.tools))
    const maxToolRounds = definition.maxToolRounds === undefined
      ? undefined
      : requirePositiveInteger(definition.maxToolRounds, 'maximum tool rounds')
    const agent = Object.freeze({
      id: requireText(definition.id, 'agent ID'),
      prompt: requireText(definition.prompt, 'agent prompt'),
      model: requireText(definition.model, 'agent model'),
      ...(allowedTools === undefined ? {} : { tools: allowedTools }),
      ...(maxToolRounds === undefined ? {} : { maxToolRounds }),
    })
    if (!models || typeof models.resolve !== 'function') {
      throw new TypeError('agent models service is required')
    }
    if (allowedTools?.length && (!tools || typeof tools.bind !== 'function')) {
      throw new TypeError('tool service is required for an agent with tools')
    }
    const registration: RegisteredAgent = {
      definition: agent,
      models,
      tools,
      snapshot: undefined,
      operations: 0,
      active: true,
    }
    try {
      this.compileAgent(registration)
    } catch (error) {
      if (!(error instanceof PendingAgentDependency)) throw error
    }

    return this.ctx.effect(() => {
      if (this.agents.has(agent.id)) throw new Error(`agent "${agent.id}" is already registered`)
      this.agents.set(agent.id, registration)
      return async () => {
        if (this.agents.get(agent.id) === registration) this.agents.delete(agent.id)
        registration.active = false
        if (registration.operations) {
          await new Promise<void>(resolve => {
            registration.resolveDrained = resolve
          })
        }
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
    return [...this.agents.values()].flatMap(registration => {
      try {
        this.refreshAgent(registration)
        return [registration.definition]
      } catch {
        return []
      }
    })
  }

  /** Reject normal process readiness while any registered agent cannot activate. */
  assertReady(): void {
    const errors = [...this.agents.values()].flatMap(registration => {
      try {
        this.refreshAgent(registration)
        return []
      } catch (error) {
        return [invalidAgent(registration.definition, error)]
      }
    })
    if (errors.length === 1) throw errors[0]
    if (errors.length > 1) {
      throw new AggregateError(errors, `multiple agents failed activation: ${errors.map(error => error.message).join('; ')}`)
    }
  }

  /** List model IDs from the caller's native Cordis model scope. */
  listModels(): readonly string[] {
    return this.ctx.agentModels.list()
  }

  /** Resolve the current agent graph and execute one transient or durable text turn. */
  run(request: Readonly<AgentRunRequest>, options?: Readonly<AgentRuntimeRunOptions>): Promise<AgentRunResult>
  run(
    request: Readonly<AgentChatStartRequest | AgentChatResumeRequest>,
    options?: Readonly<AgentRuntimeRunOptions>,
  ): Promise<AgentChatRunResult>
  run(
    request: Readonly<AgentRuntimeRequest>,
    options?: Readonly<AgentRuntimeRunOptions>,
  ): Promise<AgentRunResult | AgentChatRunResult>
  async run(
    request: Readonly<AgentRuntimeRequest>,
    options: Readonly<AgentRuntimeRunOptions> = {},
  ): Promise<AgentRunResult | AgentChatRunResult> {
    assertNotAborted(options.signal)
    return this.executeRequest(request, (agentId, message, entitlementAccount, history) => {
      return this.generateTurn(agentId, message, entitlementAccount, history, options)
    }, options.signal)
  }

  /** Execute one turn while emitting protocol-neutral incremental text. */
  stream(
    request: Readonly<AgentRunRequest>,
    emit: AgentRuntimeEventSink,
    options?: Readonly<AgentRuntimeStreamOptions>,
  ): Promise<AgentRunResult>
  stream(
    request: Readonly<AgentChatStartRequest | AgentChatResumeRequest>,
    emit: AgentRuntimeEventSink,
    options?: Readonly<AgentRuntimeStreamOptions>,
  ): Promise<AgentChatRunResult>
  stream(
    request: Readonly<AgentRuntimeRequest>,
    emit: AgentRuntimeEventSink,
    options?: Readonly<AgentRuntimeStreamOptions>,
  ): Promise<AgentRunResult | AgentChatRunResult>
  async stream(
    request: Readonly<AgentRuntimeRequest>,
    emit: AgentRuntimeEventSink,
    options: Readonly<AgentRuntimeStreamOptions> = {},
  ): Promise<AgentRunResult | AgentChatRunResult> {
    if (typeof emit !== 'function') throw new TypeError('agent event sink must be a function')
    assertNotAborted(options.signal)
    return this.executeRequest(request, (agentId, message, entitlementAccount, history) => {
      return this.streamTurn(agentId, message, entitlementAccount, history, emit, options)
    }, options.signal)
  }

  private async executeRequest(
    request: Readonly<AgentRuntimeRequest>,
    generate: TurnGenerator,
    signal?: AbortSignal,
  ): Promise<AgentRunResult | AgentChatRunResult> {
    if (isResumeRequest(request)) {
      const chatId = requireRequestText(request.chatId, 'chat ID')
      const message = requireRequestText(request.message, 'message')
      return this.withSessionProvider(provider => provider.withSession({ chatId }, async lease => {
        const session = validateSession(lease.session, { id: chatId })
        return this.executeSessionTurn(lease, session, message, generate, signal)
      }))
    }

    const agentId = requireRequestText(request?.agentId, 'agent ID')
    const message = requireRequestText(request?.message, 'message')
    if (!isPersistedStartRequest(request)) {
      return (await generate(agentId, message, request.entitlementAccount, [])).result
    }

    this.resolveAgent(agentId)
    return this.withSessionProvider(provider => provider.withSession({ agentId }, async lease => {
      const session = validateSession(lease.session, { agentId, messages: [] })
      return this.executeSessionTurn(lease, session, message, generate, signal)
    }))
  }

  private async executeSessionTurn(
    lease: AgentSessionLease,
    session: AgentSession,
    message: string,
    generate: TurnGenerator,
    signal?: AbortSignal,
  ): Promise<AgentChatRunResult> {
    const turn = await generate(session.agentId, message, session.entitlementAccount, session.messages)
    assertNotAborted(signal)
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
    history: readonly ModelConversationItem[],
    options: Readonly<AgentRuntimeRunOptions>,
  ) {
    return this.runToolLoop(
      agentId,
      message,
      requestedEntitlementAccount,
      history,
      options,
      request => request.agent.model.generate(request.request),
    )
  }

  private async streamTurn(
    agentId: string,
    message: string,
    requestedEntitlementAccount: string | undefined,
    history: readonly ModelConversationItem[],
    emit: AgentRuntimeEventSink,
    options: Readonly<AgentRuntimeStreamOptions>,
  ) {
    return this.runToolLoop(
      agentId,
      message,
      requestedEntitlementAccount,
      history,
      options,
      request => this.streamModel(request, emit, options.signal),
    )
  }

  private async runToolLoop(
    agentId: string,
    message: string,
    requestedEntitlementAccount: string | undefined,
    history: readonly ModelConversationItem[],
    options: Readonly<AgentRuntimeRunOptions>,
    generate: ModelStep,
  ): Promise<GeneratedTurn> {
    const agent = this.acquireAgent(agentId)
    let entitlementAccount: string | undefined
    try {
      entitlementAccount = agent.model.spendUnit === undefined
        ? undefined
        : requireRequestText(requestedEntitlementAccount, 'entitlement account')
    } catch (error) {
      agent.release()
      throw error
    }
    const messages: ModelConversationItem[] = [
      Object.freeze({ role: 'system' as const, content: agent.definition.prompt }),
      ...conversationItems(history),
      Object.freeze({ role: 'user' as const, content: message }),
    ]
    const usedCallIds = new Set(messages.flatMap(item => isToolCall(item) ? [item.callId] : []))

    const run = async (entitlement?: EntitlementAccount) => {
      try {
        for (let toolRound = 0; ; toolRound++) {
          assertNotAborted(options.signal)
          if (entitlement) await entitlement.assertAvailable(agent.model.spendUnit!)
          const request: Readonly<ModelRequest> = Object.freeze({
            agentId,
            messages: Object.freeze([...messages]),
            tools: agent.descriptors,
            ...(options.signal ? { signal: options.signal } : {}),
          })
          const response = await generate(Object.freeze({ agent, request }))
          const spend = validateModelSpend(agent.model, response?.spend)
          if (spend) await entitlement!.recordSpend(spend)
          assertNotAborted(options.signal)
          const generation = validateModelGeneration(agent.model, response, usedCallIds)

          if (!generation.toolCalls.length) {
            messages.push(...generation.replay)
            return Object.freeze({
              result: Object.freeze({
                agentId,
                model: agent.definition.model,
                message: generation.message,
              }),
              messages: Object.freeze(messages),
            })
          }
          if (toolRound >= agent.maxToolRounds) {
            throw new AgentRuntimeError(
              'TOOL_ROUND_LIMIT',
              `agent "${agentId}" exceeded ${agent.maxToolRounds} tool rounds`,
            )
          }
          messages.push(...generation.replay)
          const results: ModelToolResult[] = []
          for (const call of generation.toolCalls) {
            results.push(Object.freeze({
              type: 'tool-result',
              callId: call.callId,
              toolId: call.toolId,
              output: await agent.tools.invoke(
                { id: call.toolId, input: call.input },
                options.signal ? { signal: options.signal } : undefined,
              ),
            }))
          }
          messages.push(...results)
        }
      } catch (error) {
        if (options.signal?.aborted && !(error instanceof AgentRuntimeError && error.code === 'ABORTED')) {
          throw aborted(error)
        }
        throw error
      }
    }

    try {
      if (agent.model.spendUnit === undefined) return await run()
      return await this.ctx.entitlement.withAccount(entitlementAccount!, run)
    } finally {
      agent.release()
    }
  }

  private async streamModel(
    step: Readonly<ModelStepRequest>,
    emit: AgentRuntimeEventSink,
    signal?: AbortSignal,
  ): Promise<ModelGeneration> {
    const model = step.agent.model
    if (!model.stream) {
      const response = await model.generate(step.request)
      if (response?.message?.content) {
        await emit(Object.freeze({ type: 'text-delta', delta: response.message.content }))
      }
      return response
    }

    let response: ModelGeneration | undefined
    let content = ''
    for await (const event of model.stream(step.request)) {
      assertNotAborted(signal)
      if (response) {
        throw new AgentRuntimeError('INVALID_MODEL_RESPONSE', `model "${model.id}" streamed after completion`)
      }
      if (event?.type === 'text-delta' && typeof event.delta === 'string') {
        content += event.delta
        if (event.delta) await emit(Object.freeze({ type: 'text-delta', delta: event.delta }))
      } else if (event?.type === 'completed' && event.generation) {
        response = event.generation
      } else {
        throw new AgentRuntimeError('INVALID_MODEL_RESPONSE', `model "${model.id}" streamed an invalid event`)
      }
    }
    if (!response) {
      throw new AgentRuntimeError('INVALID_MODEL_RESPONSE', `model "${model.id}" did not complete its stream`)
    }
    if (response.message?.content !== content) {
      throw new AgentRuntimeError('INVALID_MODEL_RESPONSE', `model "${model.id}" streamed inconsistent text`)
    }
    return response
  }

  private resolveAgent(agentId: string) {
    const registration = this.agents.get(agentId)
    if (!registration) throw new AgentRuntimeError('UNKNOWN_AGENT', `agent "${agentId}" is not registered`)
    return registration
  }

  private compileAgent(registration: RegisteredAgent): CompiledAgent {
    const definition = registration.definition
    const model = registration.models.resolve(definition.model)
    if (!model) {
      throw new PendingAgentDependency(`model "${definition.model}" is not registered`)
    }

    const toolIds = definition.tools ?? []
    let descriptors: readonly ToolDescriptor[] = Object.freeze([])
    if (toolIds.length) {
      try {
        const available = new Set(registration.tools!.list().map(tool => tool.id))
        const missing = toolIds.find(id => !available.has(id))
        if (missing) throw new PendingAgentDependency(`tool "${missing}" is not registered`)
        descriptors = registration.tools!.bind(toolIds).descriptors
        if (!model.validateTools) {
          throw new TypeError(`model "${model.id}" does not support tools`)
        }
        const validation: unknown = model.validateTools(descriptors)
        if (validation && typeof validation === 'object' && 'then' in validation) {
          throw new TypeError(`model "${model.id}" tool validation must be synchronous`)
        }
      } catch (error) {
        if (error instanceof PendingAgentDependency) throw error
        throw new AgentRuntimeError('INVALID_AGENT', `agent "${definition.id}" has an invalid tool set`, {
          cause: error,
        })
      }
    }

    const snapshot: CompiledAgent = Object.freeze({
      modelRevision: registration.models.revision,
      toolRevision: registration.tools?.revision ?? -1,
      descriptors,
      maxToolRounds: definition.maxToolRounds ?? 8,
    })
    registration.snapshot = snapshot
    return snapshot
  }

  private refreshAgent(registration: RegisteredAgent): CompiledAgent {
    const snapshot = registration.snapshot
    if (
      !snapshot
      || snapshot.modelRevision !== registration.models.revision
      || snapshot.toolRevision !== (registration.tools?.revision ?? -1)
    ) {
      return this.compileAgent(registration)
    }
    return snapshot
  }

  private acquireAgent(agentId: string): ActiveAgent {
    const registration = this.resolveAgent(agentId)
    registration.operations++
    let model: ModelLease | undefined
    let tools: ToolLease | undefined
    try {
      let compiled: CompiledAgent
      try {
        compiled = this.refreshAgent(registration)
      } catch (error) {
        throw invalidAgent(registration.definition, error)
      }
      model = registration.models.lease(registration.definition.model)
      tools = registration.tools?.lease(registration.definition.tools ?? []) ?? emptyToolLease()
      let active = true
      return Object.freeze({
        definition: registration.definition,
        model: model.provider,
        tools,
        descriptors: compiled.descriptors,
        maxToolRounds: compiled.maxToolRounds,
        release: () => {
          if (!active) return
          active = false
          tools!.release()
          model!.release()
          registration.operations--
          if (!registration.active && !registration.operations) registration.resolveDrained?.()
        },
      })
    } catch (error) {
      tools?.release()
      model?.release()
      registration.operations--
      if (!registration.active && !registration.operations) registration.resolveDrained?.()
      throw error
    }
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

class PendingAgentDependency extends Error {}

interface RegisteredModel {
  readonly provider: ModelProvider
  leases: number
  active: boolean
  resolveDrained?: () => void
}

interface ModelLease {
  readonly provider: ModelProvider
  release(): void
}

interface RegisteredAgent {
  readonly definition: AgentDescriptor
  readonly models: AgentModelsService
  readonly tools: ToolService | undefined
  snapshot: CompiledAgent | undefined
  operations: number
  active: boolean
  resolveDrained?: () => void
}

interface CompiledAgent {
  readonly modelRevision: number
  readonly toolRevision: number
  readonly descriptors: readonly ToolDescriptor[]
  readonly maxToolRounds: number
}

interface ActiveAgent {
  readonly definition: AgentDescriptor
  readonly model: ModelProvider
  readonly tools: ToolLease
  readonly descriptors: readonly ToolDescriptor[]
  readonly maxToolRounds: number
  release(): void
}

interface ModelStepRequest {
  readonly agent: ActiveAgent
  readonly request: Readonly<ModelRequest>
}

type ModelStep = (request: Readonly<ModelStepRequest>) => Promise<ModelGeneration>

interface GeneratedTurn {
  readonly result: AgentRunResult
  readonly messages: readonly ModelConversationItem[]
}

type TurnGenerator = (
  agentId: string,
  message: string,
  entitlementAccount: string | undefined,
  history: readonly ModelConversationItem[],
) => Promise<GeneratedTurn>

interface ExpectedSession {
  readonly id?: string
  readonly owner?: AgentSessionOwner
  readonly agentId?: string
  readonly entitlementAccount?: string
  readonly messages?: readonly ModelConversationItem[]
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
    const messages = validateConversationItems(session?.messages, 'session')
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

function conversationItems(history: readonly ModelConversationItem[]): readonly ModelConversationItem[] {
  if (!history.length) return []
  const first = history[0]
  return isModelMessage(first) && first.role === 'system' ? history.slice(1) : history
}

function sameOwner(left: AgentSessionOwner, right: AgentSessionOwner) {
  return left.tenantId === right.tenantId && left.subject === right.subject
}

function sameMessages(left: readonly ModelConversationItem[], right: readonly ModelConversationItem[]) {
  return left.length === right.length && left.every((message, index) => {
    const expected = right[index]
    if (!expected || isModelMessage(message) !== isModelMessage(expected)) return false
    if (isModelMessage(message) && isModelMessage(expected)) {
      return message.role === expected.role
        && message.content === expected.content
        && sameProviderData(message.providerData, expected.providerData)
    }
    if (isToolCall(message) && isToolCall(expected)) {
      return message.callId === expected.callId
        && message.toolId === expected.toolId
        && sameJson(message.input, expected.input)
        && sameProviderData(message.providerData, expected.providerData)
    }
    if (isToolResult(message) && isToolResult(expected)) {
      return message.callId === expected.callId
        && message.toolId === expected.toolId
        && sameJson(message.output, expected.output)
    }
    if (isProviderItem(message) && isProviderItem(expected)) {
      return sameProviderData(message.providerData, expected.providerData)
    }
    return false
  })
}

function validateModelGeneration(
  model: ModelProvider,
  response: ModelGeneration,
  usedCallIds: Set<string>,
): {
  readonly message: ModelMessage
  readonly toolCalls: readonly ModelToolCall[]
  readonly replay: readonly ModelReplayItem[]
} {
  if (response?.message?.role !== 'assistant' || typeof response.message.content !== 'string') {
    throw new AgentRuntimeError('INVALID_MODEL_RESPONSE', `model "${model.id}" returned an invalid response`)
  }
  if (response.toolCalls !== undefined && !Array.isArray(response.toolCalls)) {
    throw new AgentRuntimeError('INVALID_MODEL_RESPONSE', `model "${model.id}" returned invalid tool calls`)
  }
  const callIds = new Set<string>()
  const toolCalls = Object.freeze((response.toolCalls ?? []).map(call => {
    try {
      if (call?.type !== 'tool-call') throw new TypeError('tool call type is invalid')
      const callId = requireText(call.callId, 'tool call ID')
      const toolId = requireText(call.toolId, 'tool ID')
      if (callIds.has(callId) || usedCallIds.has(callId)) {
        throw new TypeError(`tool call ID "${callId}" is duplicated`)
      }
      callIds.add(callId)
      return Object.freeze({
        type: 'tool-call' as const,
        callId,
        toolId,
        input: freezeModelJson(call.input, 'tool input'),
        ...(call.providerData === undefined
          ? {}
          : { providerData: freezeProviderData(call.providerData, 'tool call provider data') }),
      })
    } catch (error) {
      throw new AgentRuntimeError('INVALID_MODEL_RESPONSE', `model "${model.id}" returned an invalid tool call`, {
        cause: error,
      })
    }
  }))
  const message = Object.freeze({
    role: 'assistant' as const,
    content: response.message.content,
    ...(response.message.providerData === undefined
      ? {}
      : { providerData: freezeProviderData(response.message.providerData, 'message provider data') }),
  })
  const replay = response.replay === undefined
    ? Object.freeze([
        ...(message.content || !toolCalls.length ? [message] : []),
        ...toolCalls,
      ])
    : validateModelReplay(model, response.replay, message, toolCalls)
  for (const callId of callIds) usedCallIds.add(callId)
  return Object.freeze({
    message,
    toolCalls,
    replay,
  })
}

function validateModelReplay(
  model: ModelProvider,
  replay: readonly ModelReplayItem[],
  message: ModelMessage,
  toolCalls: readonly ModelToolCall[],
): readonly ModelReplayItem[] {
  if (!Array.isArray(replay)) {
    throw new AgentRuntimeError('INVALID_MODEL_RESPONSE', `model "${model.id}" returned invalid replay state`)
  }
  const replayCalls: ModelToolCall[] = []
  const replayCallIds = new Set<string>()
  const content: string[] = []
  const items = replay.map(item => {
    try {
      if (isModelMessage(item)) {
        if (item.role !== 'assistant' || typeof item.content !== 'string') {
          throw new TypeError('replay message is invalid')
        }
        content.push(item.content)
        return Object.freeze({
          role: 'assistant' as const,
          content: item.content,
          ...(item.providerData === undefined
            ? {}
            : { providerData: freezeProviderData(item.providerData, 'replay message provider data') }),
        })
      }
      if (isToolCall(item)) {
        const callId = requireText(item.callId, 'replay tool call ID')
        const toolId = requireText(item.toolId, 'replay tool ID')
        if (replayCallIds.has(callId)) throw new TypeError(`replay tool call ID "${callId}" is duplicated`)
        const call = Object.freeze({
          type: 'tool-call' as const,
          callId,
          toolId,
          input: freezeModelJson(item.input, 'replay tool input'),
          ...(item.providerData === undefined
            ? {}
            : { providerData: freezeProviderData(item.providerData, 'replay tool call provider data') }),
        })
        replayCallIds.add(callId)
        replayCalls.push(call)
        return call
      }
      if (isProviderItem(item)) {
        return Object.freeze({
          type: 'provider-item' as const,
          providerData: freezeProviderData(item.providerData, 'replay provider data'),
        })
      }
      throw new TypeError('replay item is invalid')
    } catch (error) {
      throw new AgentRuntimeError('INVALID_MODEL_RESPONSE', `model "${model.id}" returned invalid replay state`, {
        cause: error,
      })
    }
  })
  if (content.join('') !== message.content || replayCalls.length !== toolCalls.length) {
    throw new AgentRuntimeError('INVALID_MODEL_RESPONSE', `model "${model.id}" returned inconsistent replay state`)
  }
  for (const [index, expected] of toolCalls.entries()) {
    const actual = replayCalls[index]
    if (
      !actual
      || actual.callId !== expected.callId
      || actual.toolId !== expected.toolId
      || !sameJson(actual.input, expected.input)
      || !sameProviderData(actual.providerData, expected.providerData)
    ) {
      throw new AgentRuntimeError('INVALID_MODEL_RESPONSE', `model "${model.id}" returned inconsistent replay state`)
    }
  }
  return Object.freeze(items)
}

function validateConversationItems(value: unknown, label: string): readonly ModelConversationItem[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} messages must be an array`)
  const calls = new Map<string, string>()
  const results = new Set<string>()
  const items = value.map((item, index) => {
    if (isModelMessage(item)) {
      if (!['system', 'user', 'assistant'].includes(item.role) || typeof item.content !== 'string') {
        throw new TypeError(`${label} contains an invalid model message`)
      }
      if (item.role === 'system' && index !== 0) throw new TypeError(`${label} contains a misplaced system message`)
      return Object.freeze({
        role: item.role,
        content: item.content,
        ...(item.providerData === undefined
          ? {}
          : { providerData: freezeProviderData(item.providerData, `${label} message provider data`) }),
      })
    }
    if (isToolCall(item)) {
      const callId = requireText(item.callId, 'tool call ID')
      const toolId = requireText(item.toolId, 'tool ID')
      if (calls.has(callId)) throw new TypeError(`${label} contains a duplicate tool call ID`)
      calls.set(callId, toolId)
      return Object.freeze({
        type: 'tool-call' as const,
        callId,
        toolId,
        input: freezeModelJson(item.input, 'tool input'),
        ...(item.providerData === undefined
          ? {}
          : { providerData: freezeProviderData(item.providerData, `${label} tool call provider data`) }),
      })
    }
    if (isToolResult(item)) {
      const callId = requireText(item.callId, 'tool result call ID')
      const toolId = requireText(item.toolId, 'tool ID')
      if (calls.get(callId) !== toolId || results.has(callId)) {
        throw new TypeError(`${label} contains an unmatched tool result`)
      }
      results.add(callId)
      return Object.freeze({
        type: 'tool-result' as const,
        callId,
        toolId,
        output: freezeModelJson(item.output, 'tool output'),
      })
    }
    if (isProviderItem(item)) {
      return Object.freeze({
        type: 'provider-item' as const,
        providerData: freezeProviderData(item.providerData, `${label} provider data`),
      })
    }
    throw new TypeError(`${label} contains an invalid conversation item`)
  })
  if (calls.size !== results.size) throw new TypeError(`${label} contains a tool call without a result`)
  return Object.freeze(items)
}

function isModelMessage(value: unknown): value is ModelMessage {
  return !!value && typeof value === 'object' && !Object.hasOwn(value, 'type')
}

function isToolCall(value: unknown): value is ModelToolCall {
  return !!value && typeof value === 'object' && (value as { type?: unknown }).type === 'tool-call'
}

function isToolResult(value: unknown): value is ModelToolResult {
  return !!value && typeof value === 'object' && (value as { type?: unknown }).type === 'tool-result'
}

function isProviderItem(value: unknown): value is ModelProviderItem {
  return !!value && typeof value === 'object' && (value as { type?: unknown }).type === 'provider-item'
}

function freezeProviderData(value: ModelProviderData, label: string): ModelProviderData {
  if (!value || typeof value !== 'object') throw new TypeError(`${label} must be an object`)
  return Object.freeze({
    provider: requireText(value.provider, `${label} provider`),
    value: freezeModelJson(value.value, `${label} value`),
  })
}

function sameProviderData(left: ModelProviderData | undefined, right: ModelProviderData | undefined): boolean {
  if (left === undefined || right === undefined) return left === right
  return left.provider === right.provider && sameJson(left.value, right.value)
}

function freezeModelJson(value: unknown, label: string, ancestors = new Set<object>()): JsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return value
    throw new TypeError(`${label} must contain only finite JSON numbers`)
  }
  if (!value || typeof value !== 'object') throw new TypeError(`${label} must be JSON-compatible`)
  if (ancestors.has(value)) throw new TypeError(`${label} must not contain cycles`)
  ancestors.add(value)
  if (Array.isArray(value)) {
    const result = value.map(item => freezeModelJson(item, label, ancestors))
    ancestors.delete(value)
    return Object.freeze(result)
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must contain only plain objects`)
  }
  const result: { [key: string]: JsonValue } = {}
  for (const [key, item] of Object.entries(value)) {
    Object.defineProperty(result, key, {
      configurable: true,
      enumerable: true,
      value: freezeModelJson(item, label, ancestors),
      writable: true,
    })
  }
  ancestors.delete(value)
  return Object.freeze(result)
}

function sameJson(left: JsonValue, right: JsonValue): boolean {
  if (left === right) return true
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => sameJson(item, right[index]!))
  }
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false
  if (Array.isArray(left) || Array.isArray(right)) return false
  const leftObject = left as { readonly [key: string]: JsonValue }
  const rightObject = right as { readonly [key: string]: JsonValue }
  const leftKeys = Object.keys(leftObject)
  const rightKeys = Object.keys(rightObject)
  return leftKeys.length === rightKeys.length
    && leftKeys.every(key => Object.hasOwn(rightObject, key) && sameJson(leftObject[key]!, rightObject[key]!))
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

function invalidAgent(definition: AgentDescriptor, cause: unknown) {
  if (cause instanceof AgentRuntimeError && cause.code === 'INVALID_AGENT') return cause
  const detail = cause instanceof Error ? cause.message : String(cause)
  return new AgentRuntimeError('INVALID_AGENT', `agent "${definition.id}" cannot activate: ${detail}`, { cause })
}

function requireToolIds(value: readonly string[]): string[] {
  if (!Array.isArray(value)) throw new TypeError('agent tools must be an array')
  const seen = new Set<string>()
  return value.map(item => {
    const id = requireText(item, 'tool ID')
    if (seen.has(id)) throw new TypeError(`tool "${id}" appears more than once in the agent`)
    seen.add(id)
    return id
  })
}

function requirePositiveInteger(value: unknown, label: string): number {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value
  throw new TypeError(`${label} must be a positive integer`)
}

function emptyToolLease(): ToolLease {
  return Object.freeze({
    descriptors: Object.freeze([]),
    invoke: async () => {
      throw new Error('an empty tool lease cannot invoke a tool')
    },
    release() {},
  })
}

function requireRequestText(value: unknown, label: string): string {
  try {
    return requireText(value, label)
  } catch (error) {
    throw new AgentRuntimeError('INVALID_REQUEST', `${label} must be a non-empty string`, { cause: error })
  }
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw aborted(signal.reason)
}

function aborted(cause?: unknown) {
  return new AgentRuntimeError(
    'ABORTED',
    'agent turn was cancelled',
    cause === undefined ? undefined : { cause },
  )
}

export default AgentRuntimeService
