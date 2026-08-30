import { AsyncLocalStorage } from 'node:async_hooks'
import { Context } from '@karaka/cordis'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { getToolMetadata, tool, type ToolInvocationContext } from '@karaka/tool'
import ToolCore from '@karaka/tool/core'
import ToolMcpServer, {
  type Config,
  type ToolMcpEndpoint,
} from '@karaka/tool/mcp-server'
import { describe, expect, it } from 'vitest'

const inputSchema = {
  type: 'object',
  properties: { value: { type: 'integer' } },
  required: ['value'],
  additionalProperties: false,
} as const

const outputSchema = {
  type: 'object',
  properties: { result: { type: 'integer' } },
  required: ['result'],
  additionalProperties: false,
} as const

describe('Tool MCP server', () => {
  it('lists and invokes decorated application methods through modern MCP', async () => {
    const principal = new AsyncLocalStorage<string>()
    const service = calculatorService(3, principal)
    decorate(service, 'multiply', 'math.multiply', 'math.use')
    const authorizations: string[] = []
    const mounted = await mountServer({
      services: [service],
      security: {
        authenticate(request) {
          expect(request.headers.get('authorization')).toBe('Bearer service-token')
          return authInfo()
        },
        authorize(request, invoke) {
          authorizations.push(`${request.authInfo.clientId}:${request.permission}`)
          return principal.run('user-42', invoke)
        },
      },
    })
    const client = createClient(mounted.endpoint)

    try {
      await client.connect()
      const listed = await client.client.listTools()
      expect(listed.tools).toEqual([
        expect.objectContaining({
          name: 'math.multiply',
          description: 'Run math.multiply.',
          inputSchema,
          outputSchema,
        }),
      ])

      const result = await client.client.callTool({ name: 'math.multiply', arguments: { value: 4 } })
      expect(result.isError).not.toBe(true)
      expect(result.structuredContent).toEqual({ result: 12 })
      expect(result.content).toEqual([{ type: 'text', text: '{"result":12}' }])
      expect(authorizations).toEqual(['karaka:test:math.use'])
      expect(service.seenPrincipal).toBe('user-42')
    } finally {
      await client.close()
      await mounted.dispose()
    }
  })

  it('rejects untrusted hosts, origins, and callers before MCP dispatch', async () => {
    const service = calculatorService(2, new AsyncLocalStorage())
    decorate(service, 'multiply', 'math.multiply', 'math.use')
    let authenticationCalls = 0
    const mounted = await mountServer({
      services: [service],
      security: {
        authenticate(request) {
          authenticationCalls++
          if (request.headers.get('authorization') !== 'Bearer service-token') {
            return new Response('unauthorized', { status: 401 })
          }
          return authInfo()
        },
        authorize(_request, invoke) {
          return invoke()
        },
      },
    })

    try {
      const wrongHost = await mounted.endpoint.fetch(request({ host: 'attacker.example' }))
      expect(wrongHost.status).toBe(403)
      const wrongOrigin = await mounted.endpoint.fetch(request({ origin: 'https://attacker.example' }))
      expect(wrongOrigin.status).toBe(403)
      const unauthenticated = await mounted.endpoint.fetch(request({ authorization: '' }))
      expect(unauthenticated.status).toBe(401)
      expect(authenticationCalls).toBe(1)
    } finally {
      await mounted.dispose()
    }
  })

  it('redacts authorization and invocation failures from MCP results', async () => {
    const service = calculatorService(2, new AsyncLocalStorage())
    decorate(service, 'multiply', 'math.multiply', 'math.use')
    const errors: unknown[] = []
    const mounted = await mountServer({
      services: [service],
      onError: error => errors.push(error),
      security: {
        authenticate: () => authInfo(),
        async authorize() {
          throw new Error('private authorization details')
        },
      },
    })
    const client = createClient(mounted.endpoint)

    try {
      await client.connect()
      const result = await client.client.callTool({ name: 'math.multiply', arguments: { value: 4 } })
      expect(result).toMatchObject({
        isError: true,
        content: [{ type: 'text', text: 'Tool invocation failed.' }],
      })
      expect(JSON.stringify(result)).not.toContain('private authorization details')
      expect(errors).toEqual([expect.objectContaining({ message: 'private authorization details' })])
    } finally {
      await client.close()
      await mounted.dispose()
    }
  })

  it('requires permissions, object-form inputs, decorated methods, and reversible mounts', async () => {
    const ctx = new Context()

    try {
      await ctx.plugin(ToolCore)
      const undecorated = calculatorService(2, new AsyncLocalStorage())
      await expect(ctx.plugin(ToolMcpServer, config([undecorated], () => () => undefined)))
        .rejects.toThrow('found no decorated application tools')

      const missingPermission = calculatorService(2, new AsyncLocalStorage())
      decorate(missingPermission, 'multiply', 'math.unprotected')
      await expect(ctx.plugin(ToolMcpServer, config([missingPermission], () => () => undefined)))
        .rejects.toThrow('must declare a permission')

      const booleanInput = calculatorService(2, new AsyncLocalStorage())
      tool({
        id: 'math.boolean-input',
        description: 'Invalid MCP input.',
        input: true,
        output: outputSchema,
        permission: 'math.use',
      })(Object.getPrototypeOf(booleanInput), 'multiply', legacyDescriptor(booleanInput, 'multiply'))
      await expect(ctx.plugin(ToolMcpServer, config([booleanInput], () => () => undefined)))
        .rejects.toThrow('must use an object-form input schema')

      const valid = calculatorService(2, new AsyncLocalStorage())
      decorate(valid, 'multiply', 'math.multiply', 'math.use')
      await expect(ctx.plugin(ToolMcpServer, config([valid], () => undefined as never)))
        .rejects.toThrow('must return an unmount function')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('unmounts, aborts active calls, and removes registered tools on disposal', async () => {
    const service = new WaitingService()
    decorate(service, 'wait', 'jobs.wait', 'jobs.wait')
    let unmounted = false
    const mounted = await mountServer({
      services: [service],
      mount() {
        return () => {
          unmounted = true
        }
      },
    })
    const client = createClient(mounted.endpoint)

    try {
      await client.connect()
      const invocation = client.client.callTool({ name: 'jobs.wait', arguments: { value: 1 } })
      await service.started.promise
      const disposal = mounted.close()
      await expect(invocation).rejects.toThrow()
      await disposal
      expect(unmounted).toBe(true)
      expect(mounted.ctx.tools.list()).toEqual([])
    } finally {
      service.finish.resolve()
      await client.close().catch(() => undefined)
      await mounted.dispose()
    }
  })
})

function calculatorService(multiplier: number, principal: AsyncLocalStorage<string>) {
  return new class CalculatorService {
    seenPrincipal: string | undefined

    async multiply(input: { value: number }) {
      this.seenPrincipal = principal.getStore()
      return { result: input.value * multiplier }
    }
  }()
}

class WaitingService {
  readonly started = Promise.withResolvers<void>()
  readonly finish = Promise.withResolvers<void>()

  async wait(input: { value: number }, context?: ToolInvocationContext) {
    this.started.resolve()
    await Promise.race([
      this.finish.promise,
      new Promise<never>((_resolve, reject) => {
        context?.signal?.addEventListener('abort', () => reject(context.signal?.reason), { once: true })
      }),
    ])
    return { result: input.value }
  }
}

function decorate(
  service: object,
  method: string,
  id: string,
  permission?: string,
) {
  const value = Reflect.get(service, method) as (...args: never[]) => unknown
  tool({
    id,
    description: `Run ${id}.`,
    input: inputSchema,
    output: outputSchema,
    ...(permission ? { permission } : {}),
  })(Object.getPrototypeOf(service), method, legacyDescriptor(service, method))
  expect(getToolMetadata(value)?.id).toBe(id)
}

function legacyDescriptor(service: object, method: string): PropertyDescriptor {
  return Reflect.getOwnPropertyDescriptor(Object.getPrototypeOf(service), method)!
}

interface MountedServer {
  readonly ctx: Context
  readonly endpoint: ToolMcpEndpoint
  close(): Promise<void>
  dispose(): Promise<void>
}

async function mountServer(overrides: Partial<Config> & Pick<Config, 'services'>): Promise<MountedServer> {
  const ctx = new Context()
  let endpoint: ToolMcpEndpoint | undefined
  let unmount: () => void = () => undefined
  await ctx.plugin(ToolCore)
  const fiber = ctx.plugin(ToolMcpServer, config(overrides.services, value => {
    endpoint = value
    const custom = overrides.mount?.(value)
    if (custom && typeof (custom as Promise<unknown>).then === 'function') {
      throw new TypeError('test mounts must be synchronous')
    }
    unmount = (custom as (() => void) | undefined) ?? (() => undefined)
    return () => unmount()
  }, overrides))
  await fiber

  return {
    ctx,
    endpoint: endpoint!,
    close: async () => {
      await fiber.dispose()
    },
    dispose: async () => {
      await ctx.fiber.dispose()
    },
  }
}

function config(
  services: readonly object[],
  mount: Config['mount'],
  overrides: Partial<Config> = {},
): Config {
  return {
    allowedHosts: ['tools.example'],
    allowedOrigins: ['https://app.example'],
    security: {
      authenticate: () => authInfo(),
      authorize: (_request, invoke) => invoke(),
    },
    ...overrides,
    services,
    mount,
  }
}

function authInfo() {
  return {
    token: 'service-token',
    clientId: 'karaka:test',
    scopes: ['tools'],
    expiresAt: Math.floor(Date.now() / 1_000) + 60,
  }
}

function createClient(endpoint: ToolMcpEndpoint) {
  const client = new Client({ name: 'karaka-test', version: '1' }, {
    versionNegotiation: { mode: { pin: '2026-07-28' } },
  })
  const transport = new StreamableHTTPClientTransport(new URL('https://tools.example/mcp'), {
    authProvider: { token: async () => 'service-token' },
    requestInit: {
      headers: {
        host: 'tools.example',
        origin: 'https://app.example',
      },
    },
    fetch: (input, init) => {
      const source = input instanceof Request ? input : new Request(input, init)
      const headers = new Headers(source.headers)
      headers.set('host', 'tools.example')
      headers.set('origin', 'https://app.example')
      return endpoint.fetch(new Request(source, { headers }))
    },
  })

  return {
    client,
    connect: () => client.connect(transport),
    close: () => client.close(),
  }
}

function request(headers: Record<string, string>) {
  return new Request('https://tools.example/mcp', {
    method: 'POST',
    headers: {
      host: 'tools.example',
      origin: 'https://app.example',
      authorization: 'Bearer service-token',
      ...headers,
    },
    body: '{}',
  })
}
