import { Context } from '@karaka/cordis'
import Authentication, { type AuthenticationProvider } from '@karaka/authentication'
import { createMcpHandler, fromJsonSchema, McpServer, type JsonSchemaType } from '@modelcontextprotocol/server'
import { getToolMetadata, tool, type ToolInvocationContext } from '@karaka/sdk'
import ToolCore from '@karaka/tool/core'
import ToolMcpClient from '@karaka/tool/mcp-client'
import ToolMcpServer, { type ToolMcpEndpoint } from '@karaka/tool/mcp-server'
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

describe('Tool MCP client', () => {
  it('discovers, validates, registers, and invokes an application MCP tool', async () => {
    const application = new Context()
    const karaka = new Context()
    const service = new class CalculatorService {
      async multiply(input: { value: number }) {
        return { result: input.value * 3 }
      }
    }()
    decorate(service, 'multiply', 'math.multiply', 'math.use')
    const users: string[] = []
    const endpoint = await mountApplication(application, service, users)
    let authenticationCalls = 0

    try {
      await mountAuthentication(karaka, () => authenticationCalls++)
      await karaka.plugin(ToolCore)
      const client = karaka.plugin(ToolMcpClient, {
        endpoints: [{
          id: 'calculator',
          url: 'https://tools.example/mcp',
          fetch: endpointFetch(endpoint),
        }],
      })
      await client

      expect(karaka.tools.list()).toEqual([{
        id: 'math.multiply',
        version: '1',
        description: 'Run math.multiply.',
        input: inputSchema,
        output: outputSchema,
      }])
      await expect(karaka.authentication.withUser(
        { tenantId: 'acme', userId: 'user-42' },
        { id: 'application', provider: 'test-server-auth', claims: {} },
        () => karaka.tools.bind(['math.multiply']).invoke({
          id: 'math.multiply',
          input: { value: 4 },
        }),
      )).resolves.toEqual({ result: 12 })
      expect(users).toEqual(['acme:user-42'])
      expect(authenticationCalls).toBeGreaterThanOrEqual(3)

      await client.dispose()
      expect(karaka.tools.list()).toEqual([])
    } finally {
      await karaka.fiber.dispose()
      await application.fiber.dispose()
    }
  })

  it('rejects incomplete or incompatible remote descriptors before registration', async () => {
    const missingVersion = fakeEndpoint([{
      name: 'math.missing-version',
      description: 'Missing version metadata.',
      inputSchema,
      outputSchema,
    }])
    const primitiveInput = fakeEndpoint([{
      name: 'math.primitive-input',
      description: 'Uses an invalid primitive input.',
      inputSchema,
      advertisedInputSchema: { type: 'string' },
      outputSchema,
      version: '1',
    }])
    const invalidSchema = fakeEndpoint([
      validTool('math.valid-before-invalid'),
      {
        name: 'math.invalid-schema',
        description: 'Uses an invalid JSON Schema.',
        inputSchema: { ...inputSchema, unknownKeyword: true },
        outputSchema,
        version: '1',
      },
    ])
    const missingOutput = fakeEndpoint([{
      name: 'math.missing-output',
      description: 'Missing its output schema.',
      inputSchema,
      version: '1',
    }])

    await expectRejectedCatalog(missingVersion, 'invalid version')
    await expectRejectedCatalog(primitiveInput, 'Invalid result for tools/list')
    await expectRejectedCatalog(invalidSchema, 'invalid input schema')
    await expectRejectedCatalog(missingOutput, 'returned no output schema')
  })

  it('forwards invocation cancellation across MCP', async () => {
    const application = new Context()
    const karaka = new Context()
    const service = new WaitingService()
    decorate(service, 'wait', 'jobs.wait', 'jobs.wait')
    const endpoint = await mountApplication(application, service)
    const controller = new AbortController()

    try {
      await mountAuthentication(karaka)
      await karaka.plugin(ToolCore)
      await karaka.plugin(ToolMcpClient, {
        endpoints: [{
          id: 'jobs',
          url: 'https://tools.example/mcp',
          fetch: endpointFetch(endpoint),
        }],
      })
      const invocation = karaka.tools.bind(['jobs.wait']).invoke({
        id: 'jobs.wait',
        input: { value: 1 },
      }, { signal: controller.signal })
      await service.started.promise
      controller.abort(new Error('caller cancelled'))
      await expect(invocation).rejects.toMatchObject({ code: 'ABORTED' })
    } finally {
      service.finish.resolve()
      await karaka.fiber.dispose()
      await application.fiber.dispose()
    }
  })

  it('rejects duplicate logical owners instead of depending on endpoint order', async () => {
    const first = fakeEndpoint([validTool('billing.refund')])
    const second = fakeEndpoint([validTool('billing.refund')])
    const ctx = new Context()

    try {
      await mountAuthentication(ctx)
      await ctx.plugin(ToolCore)
      await expect(ctx.plugin(ToolMcpClient, {
        endpoints: [
          endpointConfig('billing-primary', 'https://primary.example/mcp', first),
          endpointConfig('billing-shadow', 'https://shadow.example/mcp', second),
        ],
      })).rejects.toThrow('is claimed by endpoints "billing-primary" and "billing-shadow"')
      expect(ctx.tools.list()).toEqual([])
    } finally {
      await ctx.fiber.dispose()
      await first.close()
      await second.close()
    }
  })

  it('requires secure, uniquely named, authenticated static endpoints', async () => {
    const ctx = new Context()
    try {
      await mountAuthentication(ctx)
      await ctx.plugin(ToolCore)
      await expect(ctx.plugin(ToolMcpClient, {
        endpoints: [{ id: 'insecure', url: 'http://tools.example/mcp' }],
      })).rejects.toThrow('must use HTTPS')
      await expect(ctx.plugin(ToolMcpClient, {
        endpoints: [{ id: 'missing-audience', url: 'https://tools.example/mcp', audience: '' }],
      })).rejects.toThrow('audience must be a non-empty string')
      await expect(ctx.plugin(ToolMcpClient, {
        endpoints: [
          { id: 'duplicate', url: 'https://one.example/mcp' },
          { id: 'duplicate', url: 'https://two.example/mcp' },
        ],
      })).rejects.toThrow('appears more than once')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

async function mountApplication(ctx: Context, service: object, users?: string[]): Promise<ToolMcpEndpoint> {
  let endpoint: ToolMcpEndpoint | undefined
  await mountAuthentication(ctx)
  await ctx.plugin(ToolCore)
  await ctx.plugin(ToolMcpServer, {
    services: [service],
    allowedHosts: ['tools.example'],
    mount(value) {
      endpoint = value
      return () => undefined
    },
    authorize(request, invoke) {
      if (request.user) users?.push(`${request.user.tenantId}:${request.user.subject}`)
      return invoke()
    },
  })
  return endpoint!
}

function decorate(service: object, method: string, id: string, permission: string) {
  const descriptor = Reflect.getOwnPropertyDescriptor(Object.getPrototypeOf(service), method)!
  tool({
    id,
    description: `Run ${id}.`,
    input: inputSchema,
    output: outputSchema,
    permission,
  })(Object.getPrototypeOf(service), method, descriptor)
  expect(getToolMetadata(Reflect.get(service, method))?.id).toBe(id)
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

function endpointFetch(endpoint: ToolMcpEndpoint) {
  return (input: string | URL | Request, init?: RequestInit) => {
    const source = input instanceof Request ? input : new Request(input, init)
    const headers = new Headers(source.headers)
    headers.set('host', 'tools.example')
    return endpoint.fetch(new Request(source, { headers }))
  }
}

interface FakeTool {
  readonly name: string
  readonly description: string
  readonly inputSchema: Record<string, unknown>
  readonly advertisedInputSchema?: Record<string, unknown>
  readonly outputSchema?: Record<string, unknown>
  readonly version?: string
}

function fakeEndpoint(tools: readonly FakeTool[]) {
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: 'fake-application', version: '1' })
    for (const definition of tools) {
      server.registerTool(definition.name, {
        description: definition.description,
        inputSchema: fromJsonSchema(definition.inputSchema as JsonSchemaType),
        ...(definition.outputSchema
          ? { outputSchema: fromJsonSchema(definition.outputSchema as JsonSchemaType) }
          : {}),
        ...(definition.version ? { _meta: { 'ai.karaka/toolVersion': definition.version } } : {}),
      }, async input => ({
        content: [{ type: 'text', text: JSON.stringify(input) }],
        structuredContent: input,
      }))
    }
    return server
  }, { legacy: 'reject' })

  return {
    async fetch(input: string | URL | Request, init?: RequestInit) {
      const response = await handler.fetch(input instanceof Request ? input : new Request(input, init))
      const payload = await response.clone().json().catch(() => undefined) as {
        result?: { tools?: Array<{ name?: string, inputSchema?: unknown }> }
      } | undefined
      if (!payload?.result?.tools) return response

      let changed = false
      for (const listed of payload.result.tools) {
        const advertised = tools.find(tool => tool.name === listed.name)?.advertisedInputSchema
        if (!advertised) continue
        listed.inputSchema = advertised
        changed = true
      }
      if (!changed) return response
      const headers = new Headers(response.headers)
      headers.delete('content-length')
      return new Response(JSON.stringify(payload), { status: response.status, headers })
    },
    close: () => handler.close(),
  }
}

function validTool(name: string): FakeTool {
  return { name, description: `Run ${name}.`, inputSchema, outputSchema, version: '1' }
}

function endpointConfig(id: string, url: string, endpoint: ReturnType<typeof fakeEndpoint>) {
  return { id, url, fetch: endpoint.fetch }
}

async function expectRejectedCatalog(endpoint: ReturnType<typeof fakeEndpoint>, message: string) {
  const ctx = new Context()
  try {
    await mountAuthentication(ctx)
    await ctx.plugin(ToolCore)
    await expect(ctx.plugin(ToolMcpClient, {
      endpoints: [endpointConfig('invalid-catalog', 'https://invalid.example/mcp', endpoint)],
    })).rejects.toThrow(message)
    expect(ctx.tools.list()).toEqual([])
  } finally {
    await ctx.fiber.dispose()
    await endpoint.close()
  }
}

async function mountAuthentication(ctx: Context, onRequest?: () => void) {
  await ctx.plugin(Authentication)
  const provider: AuthenticationProvider = {
    name: 'test-server-auth',
    async authenticate(request) {
      if (request.headers.get('authorization') !== 'Bearer service-token') throw new Error('untrusted server')
      return { id: 'karaka:test', provider: 'test-server-auth', claims: {} }
    },
    request(_target, request, dispatch) {
      onRequest?.()
      const headers = new Headers(request.headers)
      headers.set('authorization', 'Bearer service-token')
      return dispatch(new Request(request, { headers }))
    },
  }
  await ctx.plugin({
    name: 'test-server-authentication',
    inject: ['authentication'],
    apply(pluginContext) {
      pluginContext.authentication.register(provider)
    },
  })
}
