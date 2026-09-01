import { timingSafeEqual } from 'node:crypto'
import type { ServerResponse } from 'node:http'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type {
  FrameworkHttpRequest,
  KarakaToolDefinition,
  NodeHttpHandler,
  SecretSource,
  ToolCallback,
  ToolInvocationContext,
} from './types.ts'

/** Application MCP tool host configuration. */
export interface KarakaToolHostConfig {
  readonly verifyToken: SecretSource
  readonly name?: string
  readonly version?: string
}

/** Explicit application tool registry and stateless MCP HTTP handler. */
export class KarakaToolHost {
  private readonly tools = new Map<string, { readonly definition: KarakaToolDefinition; readonly callback: ToolCallback }>()
  private readonly active = new Set<Promise<void>>()
  private readonly controllers = new Set<AbortController>()
  private readonly servers = new Set<McpServer>()
  private closed = false

  constructor(private readonly config: KarakaToolHostConfig) {}

  /**
   * Register one tool explicitly, matching the MCP server authoring model.
   * @param name - unique MCP tool name.
   * @param definition - description and object-rooted input schema.
   * @param callback - trusted application operation.
   * @returns disposer for this exact registration.
   */
  registerTool(name: string, definition: KarakaToolDefinition, callback: ToolCallback): () => void {
    if (name.length === 0) throw new Error('Karaka tool name must not be empty')
    if (this.closed) throw new Error('Karaka tool host is closed')
    if (this.tools.has(name)) throw new Error(`Karaka tool "${name}" is already registered`)
    const entry = { definition, callback }
    this.tools.set(name, entry)
    return () => {
      if (this.tools.get(name) === entry) this.tools.delete(name)
    }
  }

  /**
   * Create a Node handler suitable for an Express route.
   * @returns authenticated stateless MCP handler.
   */
  expressHandler(): NodeHttpHandler {
    return (request, response) => this.handle(request, response)
  }

  /**
   * Create a Node handler suitable for a Next.js Pages API route.
   * @returns authenticated stateless MCP handler.
   */
  nextHandler(): NodeHttpHandler {
    return (request, response) => this.handle(request, response)
  }

  /** Release MCP transport resources. */
  async close(): Promise<void> {
    this.closed = true
    const error = new Error('Karaka tool host is closed')
    for (const controller of this.controllers) controller.abort(error)
    await Promise.allSettled([...this.servers].map(server => server.close()))
    await Promise.allSettled(this.active)
  }

  private handle(request: FrameworkHttpRequest, response: ServerResponse): Promise<void> {
    if (this.closed) {
      response.writeHead(503, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'tool host is closed' }))
      return Promise.resolve()
    }
    const controller = new AbortController()
    const abort = (): void => { controller.abort(new Error('MCP peer disconnected')) }
    request.once('aborted', abort)
    response.once('close', abort)
    this.controllers.add(controller)
    const operation = this.handleOperation(request, response, controller.signal).finally(() => {
      request.off('aborted', abort)
      response.off('close', abort)
      this.controllers.delete(controller)
    })
    this.active.add(operation)
    void operation.then(
      () => { this.active.delete(operation) },
      () => { this.active.delete(operation) },
    )
    return operation
  }

  private async handleOperation(
    request: FrameworkHttpRequest,
    response: ServerResponse,
    signal: AbortSignal,
  ): Promise<void> {
    let authorized: boolean
    try {
      authorized = await this.authorized(request.headers.authorization, signal)
    } catch (error: unknown) {
      if (!signal.aborted) throw error
      if (!response.destroyed && !response.headersSent) {
        response.writeHead(503, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: 'tool host is unavailable' }))
      }
      return
    }
    if (!authorized) {
      response.writeHead(401, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'unauthorized' }))
      return
    }
    if (this.closed) {
      response.writeHead(503, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'tool host is closed' }))
      return
    }
    await this.serve(request, response)
  }

  private async serve(request: FrameworkHttpRequest, response: ServerResponse): Promise<void> {
    const server = new McpServer({
      name: this.config.name ?? 'karaka-application-tools',
      version: this.config.version ?? '1.0.0',
    })
    this.servers.add(server)
    try {
      for (const [name, entry] of this.tools) {
        server.registerTool(name, entry.definition, async (arguments_, extra): Promise<CallToolResult> => {
          const identity = invocationIdentity(extra._meta?.karaka, extra.signal)
          return entry.callback(arguments_, identity)
        })
      }
      const transport = new StreamableHTTPServerTransport()
      await server.connect(transport as unknown as Transport)
      await transport.handleRequest(request, response, request.body)
    } finally {
      this.servers.delete(server)
      await server.close()
    }
  }

  private async authorized(header: string | undefined, signal: AbortSignal): Promise<boolean> {
    const match = header === undefined ? undefined : /^Bearer ([^\s]+)$/iu.exec(header)?.[1]
    if (match === undefined) return false
    const source = this.config.verifyToken
    const operation = Promise.resolve(typeof source === 'function' ? source(signal) : source)
    const expected = await abortable(operation, signal)
    const suppliedBytes = Buffer.from(match)
    const expectedBytes = Buffer.from(expected)
    return suppliedBytes.length === expectedBytes.length && timingSafeEqual(suppliedBytes, expectedBytes)
  }
}

async function abortable<Value>(operation: Promise<Value>, signal: AbortSignal): Promise<Value> {
  signal.throwIfAborted()
  return new Promise<Value>((resolve, reject) => {
    const abort = (): void => {
      reject(signal.reason instanceof Error ? signal.reason : new Error('MCP request cancelled'))
    }
    signal.addEventListener('abort', abort, { once: true })
    void operation.then(resolve, reject).finally(() => { signal.removeEventListener('abort', abort) })
  })
}

/**
 * Create an application tool registry without opening a listener.
 * @param config - inbound verification and MCP server identity.
 * @returns caller-owned tool host.
 */
export function createKarakaToolHost(config: KarakaToolHostConfig): KarakaToolHost {
  return new KarakaToolHost(config)
}

function invocationIdentity(value: unknown, signal: AbortSignal): ToolInvocationContext {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Karaka tool invocation is missing trusted identity metadata')
  }
  const record = value as Record<string, unknown>
  for (const field of ['applicationId', 'tenantId', 'userId', 'chatId'] as const) {
    if (typeof record[field] !== 'string' || record[field].length === 0) {
      throw new Error(`Karaka tool invocation identity.${field} must be a non-empty string`)
    }
  }
  return {
    applicationId: record.applicationId as string,
    tenantId: record.tenantId as string,
    userId: record.userId as string,
    chatId: record.chatId as string,
    signal,
  }
}
