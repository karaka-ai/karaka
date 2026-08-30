import type { Context } from '@karaka/cordis'
import {
  getToolMetadata,
  type JsonValue,
  type ToolDescriptor,
  type ToolJsonSchema,
} from '@karaka/sdk/tool'
import {
  createMcpHandler,
  fromJsonSchema,
  hostHeaderValidationResponse,
  McpServer,
  type AuthInfo,
  type JsonSchemaType,
  type McpHttpHandler,
} from '@modelcontextprotocol/server'

const toolVersionMetaKey = 'ai.karaka/toolVersion'

export interface ToolMcpAuthorizationRequest {
  readonly authInfo: Readonly<AuthInfo>
  readonly permission: string
  readonly request: Request
  readonly tool: ToolDescriptor
}

export interface ToolMcpSecurity {
  authenticate(request: Request): AuthInfo | Response | Promise<AuthInfo | Response>
  authorize<T>(
    request: Readonly<ToolMcpAuthorizationRequest>,
    invoke: () => Promise<T>,
  ): Promise<T>
}

export interface ToolMcpEndpoint {
  fetch(request: Request): Promise<Response>
}

export type ToolMcpUnmount = () => void | Promise<void>

/** Runtime configuration supplied by an application framework integration. */
export interface Config {
  readonly services: readonly object[]
  readonly mount: (endpoint: Readonly<ToolMcpEndpoint>) => ToolMcpUnmount | Promise<ToolMcpUnmount>
  readonly security: Readonly<ToolMcpSecurity>
  readonly allowedHosts: readonly string[]
  readonly allowedOrigins?: readonly string[]
  readonly name?: string
  readonly version?: string
  readonly onError?: (error: unknown) => void
}

/** Expose decorated application services through one modern, stateless MCP endpoint. */
export const plugin = {
  name: 'tool-mcp-server',
  inject: ['tools'],
  async apply(ctx: Context, config: Config) {
    const resolved = resolveConfig(config)
    const toolIds = registerServices(ctx, resolved.services)
    const handler = createHandler(ctx, toolIds, resolved)
    const endpoint = Object.freeze<ToolMcpEndpoint>({
      fetch: request => fetchMcp(handler, request, resolved),
    })

    let unmount: ToolMcpUnmount
    try {
      unmount = await resolved.mount(endpoint)
      if (typeof unmount !== 'function') throw new TypeError('MCP endpoint mount must return an unmount function')
    } catch (error) {
      await handler.close()
      throw error
    }

    return async () => {
      const unmounting = (async () => unmount())()
      const closing = (async () => handler.close())()
      const [unmounted, closed] = await Promise.allSettled([unmounting, closing])
      if (unmounted.status === 'rejected' && closed.status === 'rejected') {
        throw new AggregateError([unmounted.reason, closed.reason], 'MCP endpoint disposal failed')
      }
      if (unmounted.status === 'rejected') throw unmounted.reason
      if (closed.status === 'rejected') throw closed.reason
    }
  },
}

interface ResolvedConfig extends Config {
  readonly allowedOrigins: readonly string[]
  readonly name: string
  readonly version: string
}

function resolveConfig(config: Config): ResolvedConfig {
  if (!config || typeof config !== 'object') throw new TypeError('MCP server configuration must be an object')
  if (!Array.isArray(config.services) || !config.services.length) {
    throw new TypeError('MCP server requires at least one application service')
  }
  for (const service of config.services) {
    if (!service || typeof service !== 'object') throw new TypeError('MCP application services must be objects')
  }
  if (typeof config.mount !== 'function') throw new TypeError('MCP endpoint mount must be a function')
  if (
    !config.security
    || typeof config.security.authenticate !== 'function'
    || typeof config.security.authorize !== 'function'
  ) {
    throw new TypeError('MCP server security must provide authenticate and authorize functions')
  }

  const allowedHosts = requireTextArray(config.allowedHosts, 'allowed MCP host', true)
  const allowedOrigins = requireTextArray(config.allowedOrigins ?? [], 'allowed MCP origin')
  for (const origin of allowedOrigins) requireOrigin(origin)

  return Object.freeze({
    ...config,
    services: Object.freeze([...config.services]),
    allowedHosts,
    allowedOrigins,
    name: requireText(config.name ?? 'karaka-application-tools', 'MCP server name'),
    version: requireText(config.version ?? '1', 'MCP server version'),
  })
}

function registerServices(ctx: Context, services: readonly object[]): readonly string[] {
  const ids: string[] = []
  for (const service of services) {
    for (const method of decoratedMethods(service)) {
      if (!method.descriptor.permission) {
        throw new TypeError(`application tool "${method.descriptor.id}" must declare a permission`)
      }
      if (typeof method.descriptor.input === 'boolean' || method.descriptor.input.type !== 'object') {
        throw new TypeError(`application tool "${method.descriptor.id}" must use a top-level object input schema`)
      }
      ctx.tools.register({
        descriptor: method.descriptor,
        invoke: (input, context) => method.invoke(input, context),
      })
      ids.push(method.descriptor.id)
    }
  }
  if (!ids.length) throw new TypeError('MCP server found no decorated application tools')
  return Object.freeze(ids)
}

interface DecoratedMethod {
  readonly descriptor: ToolDescriptor
  readonly invoke: (input: JsonValue, context: { readonly signal?: AbortSignal }) => unknown | Promise<unknown>
}

function decoratedMethods(service: object): readonly DecoratedMethod[] {
  const methods: DecoratedMethod[] = []
  const shadowed = new Set<PropertyKey>()
  let prototype = Object.getPrototypeOf(service)

  while (prototype && prototype !== Object.prototype) {
    for (const key of Reflect.ownKeys(prototype)) {
      if (key === 'constructor' || shadowed.has(key)) continue
      shadowed.add(key)
      const method = Reflect.getOwnPropertyDescriptor(prototype, key)?.value
      const descriptor = getToolMetadata(method)
      if (!descriptor) continue
      requireServiceMethod(service, key, descriptor.id)
      methods.push(Object.freeze({
        descriptor,
        invoke: (input: JsonValue, context: { readonly signal?: AbortSignal }) => {
          const implementation = requireServiceMethod(service, key, descriptor.id)
          return Reflect.apply(implementation, service, [input, context])
        },
      }))
    }
    prototype = Object.getPrototypeOf(prototype)
  }
  return methods
}

function requireServiceMethod(service: object, key: PropertyKey, id: string): Function {
  const method = Reflect.get(service, key)
  if (typeof method === 'function') return method
  throw new TypeError(`application tool "${id}" is not callable on its service instance`)
}

function createHandler(ctx: Context, toolIds: readonly string[], config: ResolvedConfig): McpHttpHandler {
  return createMcpHandler(({ authInfo, requestInfo }) => {
    if (!authInfo || !requestInfo) throw new Error('MCP request context is unavailable')
    const tools = ctx.tools.bind(toolIds)
    const server = new McpServer({ name: config.name, version: config.version })

    for (const descriptor of tools.descriptors) {
      server.registerTool(descriptor.id, {
        description: descriptor.description,
        inputSchema: fromJsonSchema(descriptor.input as JsonSchemaType),
        outputSchema: fromJsonSchema(objectSchema(descriptor.output)),
        _meta: { [toolVersionMetaKey]: descriptor.version },
      }, async (input, requestContext) => {
        try {
          const output = await config.security.authorize({
            authInfo,
            permission: descriptor.permission!,
            request: requestInfo,
            tool: descriptor,
          }, () => tools.invoke({ id: descriptor.id, input: input as JsonValue }, {
            signal: requestContext.mcpReq.signal,
          }))
          return {
            content: [{ type: 'text', text: JSON.stringify(output) }],
            structuredContent: output,
          }
        } catch (error) {
          reportError(config, error)
          return {
            content: [{ type: 'text', text: 'Tool invocation failed.' }],
            isError: true,
          }
        }
      })
    }
    return server
  }, {
    legacy: 'reject',
    onerror: error => reportError(config, error),
  })
}

async function fetchMcp(handler: McpHttpHandler, request: Request, config: ResolvedConfig): Promise<Response> {
  const invalidHost = hostHeaderValidationResponse(request, [...config.allowedHosts])
  if (invalidHost) return invalidHost
  const invalidOrigin = validateOrigin(request, config.allowedOrigins)
  if (invalidOrigin) return invalidOrigin

  try {
    const authenticated = await config.security.authenticate(request)
    if (authenticated instanceof Response) return authenticated
    return handler.fetch(request, { authInfo: requireAuthInfo(authenticated) })
  } catch (error) {
    reportError(config, error)
    return Response.json({
      jsonrpc: '2.0',
      error: { code: -32_603, message: 'Authentication failed' },
      id: null,
    }, { status: 500 })
  }
}

function validateOrigin(request: Request, allowedOrigins: readonly string[]): Response | undefined {
  const origin = request.headers.get('origin')
  if (!origin || allowedOrigins.includes(origin)) return
  return Response.json({
    jsonrpc: '2.0',
    error: { code: -32_000, message: 'Invalid Origin' },
    id: null,
  }, { status: 403 })
}

function requireAuthInfo(value: AuthInfo): AuthInfo {
  if (
    !value
    || typeof value !== 'object'
    || typeof value.token !== 'string'
    || !value.token
    || typeof value.clientId !== 'string'
    || !value.clientId
    || !Array.isArray(value.scopes)
    || value.scopes.some(scope => typeof scope !== 'string' || !scope)
  ) {
    throw new TypeError('MCP authenticator returned invalid authentication information')
  }
  return value
}

function reportError(config: ResolvedConfig, error: unknown) {
  try {
    config.onError?.(error)
  } catch {}
}

function objectSchema(schema: ToolJsonSchema): JsonSchemaType {
  if (schema === true) return {}
  if (schema === false) return { not: {} }
  return schema as JsonSchemaType
}

function requireTextArray(value: readonly string[], label: string, requireOne = false): readonly string[] {
  if (!Array.isArray(value) || (requireOne && !value.length)) {
    throw new TypeError(`${label} list${requireOne ? ' must not be empty' : ' must be an array'}`)
  }
  return Object.freeze([...new Set(value.map(item => requireText(item, label)))])
}

function requireOrigin(value: string) {
  let url: URL
  try {
    url = new URL(value)
  } catch (cause) {
    throw new TypeError(`allowed MCP origin "${value}" is invalid`, { cause })
  }
  if (url.origin !== value || (url.protocol !== 'https:' && url.protocol !== 'http:')) {
    throw new TypeError(`allowed MCP origin "${value}" must be an HTTP origin without a path`)
  }
}

function requireText(value: unknown, label: string): string {
  if (typeof value === 'string' && value.trim()) return value
  throw new TypeError(`${label} must be a non-empty string`)
}

export default plugin
