import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { z } from 'zod'

export type {
  ApplicationAgentSummary as AgentSummary,
  ApplicationChatContent as ChatContent,
  ApplicationChatEvent as ChatEvent,
  ApplicationChatHistory as ChatHistory,
  ApplicationChatReceipt as ChatReceipt,
  ApplicationIdentity as UserIdentity,
  ApplicationModelSelection as ModelSelection,
} from './protocol.ts'

/** Secret value or per-operation secret resolver. */
export type SecretSource = string | ((signal?: AbortSignal) => string | Promise<string>)

/** Trusted invocation identity supplied outside model-generated arguments. */
export interface ToolInvocationContext {
  readonly applicationId: string
  readonly tenantId: string
  readonly userId: string
  readonly chatId: string
  readonly signal: AbortSignal
}

/** Application tool definition whose Zod input must project to DSH's enforced JSON Schema subset. */
export interface KarakaToolDefinition {
  readonly title?: string
  readonly description?: string
  readonly inputSchema: z.ZodObject<z.ZodRawShape>
}

/** Application tool callback. */
export type ToolCallback = (
  arguments_: Readonly<Record<string, unknown>>,
  context: ToolInvocationContext,
) => CallToolResult | Promise<CallToolResult>

/** Node request shape after an optional framework JSON body parser. */
export type FrameworkHttpRequest = import('node:http').IncomingMessage & {
  readonly body?: unknown
}

/** Node HTTP handler shared by Express and Next.js API routes. */
export type NodeHttpHandler = (
  request: FrameworkHttpRequest,
  response: import('node:http').ServerResponse,
) => void | Promise<void>
