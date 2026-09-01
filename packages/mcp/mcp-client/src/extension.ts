import type { ToolExecution, ToolVisibilityContext } from '@deepseek-ai/dsh-tools'

/** Optional policy supplied by a plugin that specializes the generic MCP bridge. */
export interface McpClientExtension {
  /**
   * Resolve additional Streamable HTTP request headers.
   * @param signal - request cancellation signal, when supplied by the MCP SDK.
   * @returns headers merged after the endpoint's static configured headers.
   */
  requestHeaders?(this: void, signal: AbortSignal | undefined): Promise<Record<string, string>>
  /**
   * Build protocol metadata for one MCP tool call.
   * @param execution - accepted harness tool execution.
   * @returns MCP `_meta` fields, or undefined when no metadata is required.
   */
  invocationMeta?(this: void, execution: Readonly<ToolExecution>): Record<string, unknown> | undefined
  /**
   * Decide whether one discovered tool is visible in a registry view.
   * @param publicName - server-qualified harness tool name.
   * @param visibility - scope and explicit-selection facts from ToolRuntime.
   * @returns whether the tool may be presented and dispatched.
   */
  isToolVisible?(this: void, publicName: string, visibility: Readonly<ToolVisibilityContext>): boolean
}
