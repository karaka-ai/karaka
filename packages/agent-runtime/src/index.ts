import { Service, type Context } from '@karaka/cordis'
import type { EntitlementAccount, SpendAmount } from '@karaka/entitlement'

declare module '@karaka/cordis' {
  interface Context {
    agentRuntime: AgentRuntimeService
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

/** Input for the initial single-turn Agent Runtime slice. */
export interface AgentRunRequest {
  readonly agentId: string
  readonly message: string
  /** Overall entitlement account. Required only for metered models. */
  readonly entitlementAccount?: string
}

/** Output from one single-turn agent run. */
export interface AgentRunResult {
  readonly agentId: string
  readonly model: string
  readonly message: ModelMessage
}

/** Stable Agent Runtime failures independent of model implementations. */
export type AgentRuntimeErrorCode =
  | 'INVALID_REQUEST'
  | 'UNKNOWN_AGENT'
  | 'UNKNOWN_MODEL'
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

  private readonly agents = new Map<string, AgentDescriptor>()
  private readonly models = new Map<string, ModelProvider>()

  constructor(ctx: Context) {
    super(ctx, 'agentRuntime')
  }

  /** Register an agent descriptor until the contributing plugin unloads. */
  registerAgent(definition: Readonly<AgentDescriptor>) {
    const agent = Object.freeze({
      id: requireText(definition.id, 'agent ID'),
      prompt: requireText(definition.prompt, 'agent prompt'),
      model: requireText(definition.model, 'agent model'),
    })

    return this.ctx.effect(() => {
      if (this.agents.has(agent.id)) throw new Error(`agent "${agent.id}" is already registered`)
      this.agents.set(agent.id, agent)
      return () => {
        if (this.agents.get(agent.id) === agent) this.agents.delete(agent.id)
      }
    }, `agentRuntime.registerAgent(${JSON.stringify(agent.id)})`)
  }

  /** Register a model provider until the contributing plugin unloads. */
  registerModel(provider: ModelProvider) {
    const id = requireText(provider.id, 'model ID')
    if (provider.spendUnit !== undefined) requireText(provider.spendUnit, 'model spend unit')

    return this.ctx.effect(() => {
      if (this.models.has(id)) throw new Error(`model "${id}" is already registered`)
      this.models.set(id, provider)
      return () => {
        if (this.models.get(id) === provider) this.models.delete(id)
      }
    }, `agentRuntime.registerModel(${JSON.stringify(id)})`)
  }

  /** List active agent descriptors without exposing mutable registry state. */
  listAgents(): readonly AgentDescriptor[] {
    return [...this.agents.values()]
  }

  /** List active model IDs without exposing provider implementations. */
  listModels(): readonly string[] {
    return [...this.models.keys()]
  }

  /** Resolve an agent and its model provider, then execute one text turn. */
  async run(request: Readonly<AgentRunRequest>): Promise<AgentRunResult> {
    const agentId = requireRequestText(request?.agentId, 'agent ID')
    const message = requireRequestText(request?.message, 'message')
    const agent = this.agents.get(agentId)
    if (!agent) throw new AgentRuntimeError('UNKNOWN_AGENT', `agent "${agentId}" is not registered`)

    const model = this.models.get(agent.model)
    if (!model) throw new AgentRuntimeError('UNKNOWN_MODEL', `model "${agent.model}" is not registered`)

    const entitlementAccount = model.spendUnit === undefined
      ? undefined
      : requireRequestText(request.entitlementAccount, 'entitlement account')
    const messages = Object.freeze([
      Object.freeze({ role: 'system' as const, content: agent.prompt }),
      Object.freeze({ role: 'user' as const, content: message }),
    ])
    const generate = async (entitlement?: EntitlementAccount) => {
      const response = await model.generate(Object.freeze({ agentId, messages }))
      const spend = validateModelSpend(model, response?.spend)
      if (spend) await entitlement!.recordSpend(spend)
      if (response?.message?.role !== 'assistant' || typeof response.message.content !== 'string') {
        throw new AgentRuntimeError('INVALID_MODEL_RESPONSE', `model "${agent.model}" returned an invalid response`)
      }

      return Object.freeze({
        agentId,
        model: agent.model,
        message: Object.freeze({ role: response.message.role, content: response.message.content }),
      })
    }

    if (model.spendUnit === undefined) return generate()
    return this.ctx.entitlement.withAccount(entitlementAccount!, async (entitlement) => {
      await entitlement.assertAvailable(model.spendUnit!)
      return generate(entitlement)
    })
  }
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
