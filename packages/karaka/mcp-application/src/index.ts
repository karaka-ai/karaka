/** Authenticated MCP bridge from Karaka Agent sessions to application-owned tools. */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import { ApplicationId } from '@deepseek-ai/dsh-session'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import type { ToolExecution, ToolVisibilityContext } from '@deepseek-ai/dsh-tools'
import type {} from '@karaka/server-auth'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'karaka-mcp-application'

/** Services required by the authenticated application bridge. */
export const inject = ['tools', 'serverAuth']

/** One authenticated application MCP endpoint. */
export interface Config {
  /** Application allowed to receive calls through this endpoint. */
  applicationId: string
  /** Stable namespace for model-facing tool names. */
  serverName: string
  /** Streamable HTTP MCP endpoint URL. */
  url: string
  /** Static headers attached before dynamic authorization. */
  headers: Record<string, string>
  /** Per-tool-call timeout in milliseconds. */
  toolCallTimeoutMs: number
  /** Fail activation when initial connection or discovery fails. */
  failOnStartupError: boolean
  /** Automatic reconnect policy after a lost connection. */
  reconnect?: McpClient.ReconnectConfig
}

type ConfigInput = Omit<Config, 'headers' | 'toolCallTimeoutMs' | 'failOnStartupError'>
  & Partial<Pick<Config, 'headers' | 'toolCallTimeoutMs' | 'failOnStartupError'>>

/** Configuration for one authenticated application MCP endpoint. */
export const Config = z.object({
  applicationId: z.string().required(),
  serverName: z.string().required().pattern(/^[A-Za-z0-9_-]{1,32}$/),
  url: z.string().required(),
  headers: z.dict(String).default({}),
  toolCallTimeoutMs: z.number().default(60_000),
  failOnStartupError: z.boolean().default(false),
  reconnect: z.object({
    enabled: z.boolean().default(true),
    initialDelayMs: z.number().min(1).max(MAX_TIMER_DELAY_MS).default(500),
    maxDelayMs: z.number().min(1).max(MAX_TIMER_DELAY_MS).default(30_000),
    maxAttempts: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(10),
  }),
}) as unknown as z<ConfigInput, Config>

/**
 * Connect one application MCP endpoint through the shared generic bridge.
 * @param ctx - plugin context carrying tools and server authentication.
 * @param config - resolved application identity and MCP endpoint configuration.
 * @returns startup readiness after authenticated discovery completes.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  if (config.applicationId.length === 0) throw new Error('mcp-application: applicationId must not be empty')
  const applicationId = ApplicationId(config.applicationId)
  const { applicationId: _applicationId, ...endpoint } = config
  await McpClient.apply(ctx, { transport: 'streamable-http', ...endpoint }, {
    requestHeaders: async signal => ({
      authorization: await ctx.serverAuth.authorizeTools(applicationId, signal),
    }),
    invocationMeta: execution => ({ karaka: invocationIdentity(execution, applicationId, config.serverName) }),
    isToolVisible: (_publicName, visibility) => isApplicationToolVisible(visibility, applicationId),
  })
}

function invocationIdentity(
  execution: Readonly<ToolExecution>,
  applicationId: ApplicationId,
  serverName: string,
): Record<string, string> {
  const session = execution.agent?.session
  const owner = session?.header.applicationOwner
  if (session === undefined || owner === undefined) {
    throw new Error(`mcp-application(${serverName}): application tool requires an application-owned Agent session`)
  }
  if (owner.applicationId !== applicationId) {
    throw new Error(`mcp-application(${serverName}): session application "${owner.applicationId}" does not match endpoint application "${applicationId}"`)
  }
  return {
    applicationId: owner.applicationId,
    tenantId: owner.tenantId,
    userId: owner.userId,
    chatId: session.id,
  }
}

function isApplicationToolVisible(
  visibility: Readonly<ToolVisibilityContext>,
  applicationId: ApplicationId,
): boolean {
  if (!visibility.inherited || !visibility.explicitlyAllowed) return false
  const scope = visibility.scope
  if (scope === undefined || !('session' in scope)) return false
  const session = scope.session
  if (typeof session !== 'object' || session === null || !('header' in session)) return false
  const header = session.header
  if (typeof header !== 'object' || header === null || !('applicationOwner' in header)) return false
  const owner = header.applicationOwner
  return typeof owner === 'object' && owner !== null
    && 'applicationId' in owner && owner.applicationId === applicationId
}
