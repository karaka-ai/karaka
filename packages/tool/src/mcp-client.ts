import type { Context } from '@karaka/cordis'
import {
  defineTool,
  type JsonValue,
  type ToolDescriptor,
  type ToolInvocationContext,
  type ToolJsonSchema,
} from '@karaka/sdk/tool'
import {
  Client,
  StreamableHTTPClientTransport,
  type FetchLike,
  type Tool as McpTool,
} from '@modelcontextprotocol/client'

const protocolVersion = '2026-07-28'
const toolVersionMetaKey = 'ai.karaka/toolVersion'
const endpointIdPattern = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/

export type ToolMcpTokenSource = string | (() => string | Promise<string>)

export interface ToolMcpClientEndpoint {
  readonly id: string
  readonly url: string
  readonly token: ToolMcpTokenSource
  readonly timeoutMs?: number
  /** Advanced test or host integration hook. Normal deployments use global fetch. */
  readonly fetch?: FetchLike
}

export interface Config {
  readonly endpoints: readonly ToolMcpClientEndpoint[]
  readonly name?: string
  readonly version?: string
}

/** Discover and invoke remote application tools through pinned modern MCP endpoints. */
export const plugin = {
  name: 'tool-mcp-client',
  inject: ['tools'],
  async apply(ctx: Context, config: Config) {
    const resolved = resolveConfig(config)
    const connections = await openEndpoints(resolved)

    try {
      registerRemoteTools(ctx, connections)
    } catch (error) {
      await closeConnections(connections, error)
    }

    return () => closeConnections(connections)
  },
}

interface ResolvedEndpoint extends Omit<ToolMcpClientEndpoint, 'url' | 'timeoutMs'> {
  readonly url: URL
  readonly timeoutMs: number | undefined
}

interface ResolvedConfig {
  readonly endpoints: readonly ResolvedEndpoint[]
  readonly name: string
  readonly version: string
}

interface RemoteTool {
  readonly descriptor: ToolDescriptor
  readonly definition: McpTool
}

interface Connection {
  readonly endpoint: ResolvedEndpoint
  readonly client: Client
  readonly tools: readonly RemoteTool[]
}

function resolveConfig(config: Config): ResolvedConfig {
  if (!config || typeof config !== 'object') throw new TypeError('MCP client configuration must be an object')
  if (!Array.isArray(config.endpoints) || !config.endpoints.length) {
    throw new TypeError('MCP client requires at least one endpoint')
  }

  const ids = new Set<string>()
  const endpoints = config.endpoints.map(endpoint => {
    if (!endpoint || typeof endpoint !== 'object') throw new TypeError('MCP client endpoints must be objects')
    const id = requireText(endpoint.id, 'MCP endpoint ID')
    if (!endpointIdPattern.test(id)) throw new TypeError('MCP endpoint ID must be a stable name')
    if (ids.has(id)) throw new TypeError(`MCP endpoint "${id}" appears more than once`)
    ids.add(id)

    const token = endpoint.token
    if (typeof token === 'string') requireText(token, `MCP endpoint "${id}" token`)
    else if (typeof token !== 'function') throw new TypeError(`MCP endpoint "${id}" requires a token source`)

    return Object.freeze<ResolvedEndpoint>({
      ...endpoint,
      id,
      url: requireEndpointUrl(endpoint.url),
      token,
      timeoutMs: optionalPositiveInteger(endpoint.timeoutMs, `MCP endpoint "${id}" timeout`),
    })
  })

  return Object.freeze({
    endpoints: Object.freeze(endpoints),
    name: requireText(config.name ?? 'karaka-tool-client', 'MCP client name'),
    version: requireText(config.version ?? '1', 'MCP client version'),
  })
}

async function openEndpoints(config: ResolvedConfig): Promise<readonly Connection[]> {
  const settled = await Promise.allSettled(config.endpoints.map(endpoint => openEndpoint(config, endpoint)))
  const connections = settled.flatMap(result => result.status === 'fulfilled' ? [result.value] : [])
  const errors = settled.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
  if (!errors.length) return Object.freeze(connections)

  const failure = errors.length === 1 ? errors[0] : new AggregateError(errors, 'MCP endpoints failed to connect')
  return closeConnections(connections, failure)
}

async function openEndpoint(config: ResolvedConfig, endpoint: ResolvedEndpoint): Promise<Connection> {
  const client = new Client({ name: `${config.name}:${endpoint.id}`, version: config.version }, {
    enforceStrictCapabilities: true,
    versionNegotiation: { mode: { pin: protocolVersion } },
  })
  const transport = new StreamableHTTPClientTransport(endpoint.url, {
    authProvider: {
      token: async () => requireText(await resolveToken(endpoint.token), `MCP endpoint "${endpoint.id}" token`),
    },
    ...(endpoint.fetch ? { fetch: endpoint.fetch } : {}),
    onInsufficientScope: 'throw',
  })

  try {
    await client.connect(transport, requestOptions(endpoint))
    const listed = await client.listTools(undefined, requestOptions(endpoint))
    const tools = listed.tools.map(tool => Object.freeze({
      definition: tool,
      descriptor: remoteDescriptor(tool, endpoint.id),
    }))
    return Object.freeze({ endpoint, client, tools: Object.freeze(tools) })
  } catch (error) {
    try {
      await client.close()
    } catch (closeError) {
      throw new AggregateError([error, closeError], `MCP endpoint "${endpoint.id}" failed to open and close`)
    }
    throw error
  }
}

function registerRemoteTools(ctx: Context, connections: readonly Connection[]) {
  const owners = new Map<string, string>()
  for (const connection of connections) {
    for (const tool of connection.tools) {
      const owner = owners.get(tool.descriptor.id)
      if (owner) {
        throw new TypeError(`MCP tool "${tool.descriptor.id}" is claimed by endpoints "${owner}" and "${connection.endpoint.id}"`)
      }
      owners.set(tool.descriptor.id, connection.endpoint.id)
    }
  }

  for (const connection of connections) {
    for (const tool of connection.tools) {
      ctx.tools.register({
        descriptor: tool.descriptor,
        invoke: (input, context) => invokeRemote(connection, tool, input, context),
      })
    }
  }
}

async function invokeRemote(
  connection: Connection,
  tool: RemoteTool,
  input: JsonValue,
  context: Readonly<ToolInvocationContext>,
): Promise<JsonValue> {
  const result = await connection.client.callTool({
    name: tool.descriptor.id,
    arguments: input as Record<string, unknown>,
  }, {
    ...requestOptions(connection.endpoint),
    ...(context.signal ? { signal: context.signal } : {}),
    toolDefinition: tool.definition,
  })
  if (result.isError) throw new Error(`remote MCP tool "${tool.descriptor.id}" reported a failure`)
  if (result.structuredContent === undefined) {
    throw new Error(`remote MCP tool "${tool.descriptor.id}" returned no structured content`)
  }
  return result.structuredContent as JsonValue
}

function remoteDescriptor(tool: McpTool, endpointId: string): ToolDescriptor {
  const version = tool._meta?.[toolVersionMetaKey]
  if (typeof version !== 'string' || !version.trim() || version.length > 128 || containsControl(version)) {
    throw new TypeError(`MCP endpoint "${endpointId}" returned an invalid version for tool "${safeToolId(tool.name)}"`)
  }
  if (typeof tool.description !== 'string' || !tool.description.trim()) {
    throw new TypeError(`MCP endpoint "${endpointId}" returned no description for tool "${safeToolId(tool.name)}"`)
  }
  if (!isRecord(tool.inputSchema) || tool.inputSchema.type !== 'object') {
    throw new TypeError(`MCP endpoint "${endpointId}" returned a non-object input schema for tool "${safeToolId(tool.name)}"`)
  }
  if (!isRecord(tool.outputSchema)) {
    throw new TypeError(`MCP endpoint "${endpointId}" returned no output schema for tool "${safeToolId(tool.name)}"`)
  }

  return defineTool({
    id: tool.name,
    version,
    description: tool.description,
    input: tool.inputSchema as ToolJsonSchema,
    output: tool.outputSchema as ToolJsonSchema,
  })
}

function closeConnections(connections: readonly Connection[], cause: unknown): Promise<never>
function closeConnections(connections: readonly Connection[]): Promise<void>
async function closeConnections(connections: readonly Connection[], cause?: unknown): Promise<never | void> {
  const settled = await Promise.allSettled(connections.map(connection => connection.client.close()))
  const errors = settled.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
  if (cause !== undefined) {
    if (errors.length) throw new AggregateError([cause, ...errors], 'MCP client cleanup failed')
    throw cause
  }
  if (errors.length === 1) throw errors[0]
  if (errors.length > 1) throw new AggregateError(errors, 'MCP clients failed to close')
}

function requestOptions(endpoint: ResolvedEndpoint) {
  return endpoint.timeoutMs === undefined ? {} : { timeout: endpoint.timeoutMs }
}

async function resolveToken(source: ToolMcpTokenSource) {
  return typeof source === 'function' ? source() : source
}

function requireEndpointUrl(value: unknown): URL {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError('MCP endpoint URL must be a non-empty string')
  let url: URL
  try {
    url = new URL(value)
  } catch (cause) {
    throw new TypeError('MCP endpoint URL is invalid', { cause })
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new TypeError('MCP endpoint URL must use HTTPS without credentials or a fragment')
  }
  return url
}

function optionalPositiveInteger(value: unknown, label: string): number | undefined {
  if (value === undefined) return
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value
  throw new TypeError(`${label} must be a positive integer`)
}

function requireText(value: unknown, label: string): string {
  if (typeof value === 'string' && value.trim()) return value
  throw new TypeError(`${label} must be a non-empty string`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function containsControl(value: string) {
  for (const character of value) {
    const codePoint = character.codePointAt(0)!
    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) return true
  }
  return false
}

function safeToolId(value: unknown) {
  return typeof value === 'string' && endpointIdPattern.test(value) ? value : '<invalid>'
}

export default plugin
