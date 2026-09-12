/** Application MCP bridge, derived from DSH c291e796 with an owned scoped catalog. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { policyAllows, registerCatalog, watchPolicy } from './policy.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolDefinition, ToolExecution } from '@deepseek-ai/dsh-tools'
import { ApplicationId } from '@karaka-ai/identity'
import type {} from '@karaka-ai/server-auth'
import { resolveReconnectPolicy, startConnection, type ReconnectConfig } from './connection.ts'

export const name = 'karaka-mcp-application'
export const inject = ['tools', 'agents', 'karakaIdentity', 'serverAuth']
export interface Config {
  applicationId: string
  serverName: string
  url: string
  headers: Record<string, string>
  toolCallTimeoutMs: number
  failOnStartupError: boolean
  reconnect?: ReconnectConfig
  /** Only these public MCP tool names are exposed to this application's Agents. */
  allow: string[]
  /** Deny overrides the explicit allow list. */
  deny: string[]
}
export const Config = z.object({
  applicationId: z.string().required(),
  serverName: z.string().required().pattern(/^[A-Za-z0-9_-]{1,32}$/),
  url: z.string().required(),
  headers: z.dict(String).default({}),
  toolCallTimeoutMs: z.number().min(1).default(60_000),
  failOnStartupError: z.boolean().default(true),
  allow: z.array(String).default([]),
  deny: z.array(String).default([]),
  reconnect: z.object({
    enabled: z.boolean().default(true),
    initialDelayMs: z.number().min(1).default(500),
    maxDelayMs: z.number().min(1).default(30_000),
    maxAttempts: z.number().step(1).min(1).default(10),
  }),
}) as z<Config>

/** Hooks owned by this bridge rather than added to upstream Tools or MCP. */
export interface ApplicationBridge {
  headers(signal?: AbortSignal): Promise<Record<string, string>>
  metadata(execution: ToolExecution): Promise<Record<string, unknown>>
  register(definition: ToolDefinition): () => void
}

export async function apply(ctx: Context, config: Config): Promise<void> {
  const applicationId = ApplicationId(config.applicationId)
  const allowed = new Set(config.allow)
  const denied = new Set(config.deny)
  const catalog = new Map<string, ToolDefinition>()
  const agents = new Map<Agent, Map<string, () => void>>()

  function registerFor(agent: Agent, definition: ToolDefinition): void {
    const registrations = agents.get(agent)!
    if (!allowed.has(definition.name) || denied.has(definition.name) || !policyAllows(agent, definition.name)) return
    registrations.set(definition.name, agent.ctx.tools.register(definition))
  }
  function attach(agent: Agent): void {
    if (agents.has(agent)) return
    const owner = ctx.karakaIdentity.ownerOfCached(agent.session)
    if (owner?.applicationId !== applicationId) return
    const registrations = new Map<string, () => void>()
    agents.set(agent, registrations)
    agent.ctx.effect(() => () => {
      for (const dispose of registrations.values()) dispose()
      agents.delete(agent)
    }, 'karaka-mcp-application.agent')
    for (const definition of catalog.values()) registerFor(agent, definition)
  }
  const bridge: ApplicationBridge = {
    async headers(signal) {
      return { authorization: await ctx.serverAuth.authorizeTools(applicationId, signal) }
    },
    async metadata(execution) {
      if (execution.agent === undefined) throw new Error('Application tool requires an Agent')
      const owner = await ctx.karakaIdentity.ownerOf(execution.agent.session)
      if (owner?.applicationId !== applicationId) throw new Error('Application tool owner does not match endpoint')
      if (!allowed.has(execution.name) || denied.has(execution.name) || !policyAllows(execution.agent, execution.name)) throw new Error('Application tool is not allowed')
      return { karaka: { ...owner, chatId: execution.agent.session.id } }
    },
    register(definition) {
      if (catalog.has(definition.name)) throw new Error(`Duplicate application MCP tool: ${definition.name}`)
      catalog.set(definition.name, definition)
      const unregisterCatalog = registerCatalog(ctx, definition.name)
      try {
        for (const agent of agents.keys()) registerFor(agent, definition)
      } catch (error) {
        remove()
        throw error
      }
      function remove() {
        unregisterCatalog()
        catalog.delete(definition.name)
        for (const registrations of agents.values()) {
          registrations.get(definition.name)?.()
          registrations.delete(definition.name)
        }
      }
      return remove
    },
  }
  ctx.effect(() => watchPolicy(ctx, () => {
    for (const [agent, registrations] of agents) {
      for (const dispose of registrations.values()) dispose()
      registrations.clear()
      for (const definition of catalog.values()) registerFor(agent, definition)
    }
  }), 'karaka-mcp-application.policy')
  ctx.on('agent/created', ({ agent }) => attach(agent), { global: true })
  // Application roots and children are published only after their trusted identity setup.
  for (const agent of ctx.agents.list()) attach(agent)
  const connection = startConnection(ctx, config, resolveReconnectPolicy(config.reconnect, name), bridge)
  ctx.effect(() => () => connection.dispose(), 'karaka-mcp-application.connection')
  const outcome = await connection.ready
  if (outcome.error !== undefined && config.failOnStartupError) {
    throw new Error(`Application MCP ${config.serverName} could not start`, { cause: outcome.error })
  }
}
