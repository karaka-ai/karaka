/**
 * Scoped MCP resource providers and the shared model-facing resource tools.
 *
 * @module @deepseek-ai/dsh-mcp-resources
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import { NamedEntries, ScopedLayers, type ScopeLayer } from '@deepseek-ai/dsh-scope'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { registerResourceTools } from './tools.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    mcpResources: McpResourceRuntime
  }
}

/** One supported resource operation, with server-owned cursors and URIs. */
export type McpResourceRequest =
  | { method: 'resources/list' | 'resources/templates/list'; cursor?: string }
  | { method: 'resources/read'; uri: string }

/** One configured server's resource access, owned by its MCP connection plugin. */
export interface McpResourceProvider {
  /**
   * Run an operation against one live connection generation.
   * @param request - MCP resource method and parameters.
   * @param exec - caller identity and cancellation for this invocation.
   * @returns the protocol result as lossless JSON.
   */
  request(request: McpResourceRequest, exec: ToolExecution): Promise<JsonValue>
}

class ResourceLayer implements ScopeLayer {
  readonly servers = new NamedEntries<McpResourceProvider>(name =>
    new Error(`MCP resource server "${name}" is already registered in this scope`))

  isEmpty(): boolean {
    return this.servers.isEmpty()
  }
}

/** Scoped resource access plus three tools shared by configured MCP servers. */
export class McpResourceRuntime extends Service {
  /** Tool registry required by the resource consumer. */
  static inject = ['tools']

  private readonly layers = new ScopedLayers(() => new ResourceLayer(), () => undefined)

  constructor(ctx: Context) {
    super(ctx, 'mcpResources')

    registerResourceTools(ctx, (server, request, exec) => this.request(server, request, exec))
    ctx.inject(['systemPrompt'], (inner) => {
      inner.systemPrompt.section({
        name: 'mcp-resource-servers',
        order: inner.systemPrompt.getSectionOrder('MCP_SERVERS'),
        interpolate: false,
        text: ({ scope }) => {
          const names = [...this.layers.merge(scope, layer => layer.servers).keys()].sort()
          return names.length === 0 ? '' : '## MCP resource servers\n\n'
            + 'Use list_mcp_resources, list_mcp_resource_templates, or read_mcp_resource with one of these names '
            + `as the server argument: ${JSON.stringify(names)}.`
        },
      })
    })
  }

  /**
   * Register one server in the caller's Cordis scope.
   * @param server - configured server name, unique in this scope.
   * @param provider - connection-owned resource operations.
   * @returns the effect disposer for this exact registration.
   */
  register(server: string, provider: McpResourceProvider): () => void {
    return this.layers.effect(this.ctx, layer => layer.servers.insert(server, provider), {
      label: `mcpResources.register(${server})`,
    })
  }

  /** Resolve the caller-visible server before starting any network operation. */
  private request(server: string, request: McpResourceRequest, exec: ToolExecution): Promise<JsonValue> {
    const provider = this.layers.merge(exec.agent, layer => layer.servers).get(server)
    if (!provider) throw new Error(`MCP resource server "${server}" is unavailable in this agent's scope`)
    return provider.request(request, exec)
  }
}

export default McpResourceRuntime
