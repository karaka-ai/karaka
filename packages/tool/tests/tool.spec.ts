import { Context } from '@karaka/cordis'
import {
  defineTool,
  getToolMetadata,
  tool,
  type JsonValue,
  type ToolContribution,
} from '@karaka/tool'
import ToolCore, { ToolError } from '@karaka/tool/core'
import { describe, expect, it } from 'vitest'

const inputSchema = {
  type: 'object',
  properties: {
    value: { type: 'integer' },
  },
  required: ['value'],
  additionalProperties: false,
} as const

const outputSchema = {
  type: 'object',
  properties: {
    doubled: { type: 'integer' },
  },
  required: ['doubled'],
  additionalProperties: false,
} as const

describe('Tool authoring API', () => {
  it('attaches immutable metadata without registering global behavior', () => {
    const mutableInput = {
      type: 'object',
      properties: { invoiceId: { type: 'string' } },
      required: ['invoiceId'],
      additionalProperties: false,
    }

    class InvoiceService {
      async refund(this: InvoiceService, input: { invoiceId: string }) {
        return { refunded: input.invoiceId }
      }
    }
    const refund = InvoiceService.prototype.refund
    tool({
      id: 'invoices.refund',
      description: 'Refund an eligible invoice.',
      input: mutableInput,
      output: { type: 'object' },
      permission: 'invoices.refund',
    })(refund, {
      kind: 'method',
      name: 'refund',
      static: false,
      private: false,
      access: {
        has: object => 'refund' in object,
        get: object => object.refund,
      },
      addInitializer() {},
      metadata: {},
    })

    const metadata = getToolMetadata(refund)
    mutableInput.required.push('laterMutation')

    expect(metadata).toEqual({
      id: 'invoices.refund',
      version: '1',
      description: 'Refund an eligible invoice.',
      input: {
        type: 'object',
        properties: { invoiceId: { type: 'string' } },
        required: ['invoiceId'],
        additionalProperties: false,
      },
      output: { type: 'object' },
      permission: 'invoices.refund',
    })
    expect(Object.isFrozen(metadata)).toBe(true)
    expect(Object.isFrozen(metadata?.input)).toBe(true)
    expect(getToolMetadata(() => undefined)).toBeUndefined()
  })

  it('supports legacy method decorators without a second registry', () => {
    class Service {
      run() {}
    }
    const descriptor = Object.getOwnPropertyDescriptor(Service.prototype, 'run')!

    tool({
      id: 'service.run',
      version: '2',
      description: 'Run the service.',
      input: true,
      output: true,
    })(Service.prototype, 'run', descriptor)

    expect(getToolMetadata(Service.prototype.run)).toMatchObject({ id: 'service.run', version: '2' })

    class StaticService {
      static run() {}
    }
    expect(() => tool({
      id: 'static.run',
      description: 'Invalid static tool.',
      input: true,
      output: true,
    })(StaticService, 'run', Object.getOwnPropertyDescriptor(StaticService, 'run')!)).toThrow(
      '@tool can decorate only public instance methods',
    )
  })

  it('rejects unstable definitions and non-JSON schemas', () => {
    expect(() => defineTool({
      id: 'spaces are invalid',
      description: 'Invalid.',
      input: true,
      output: true,
    })).toThrow('tool ID must be a stable name')

    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(() => defineTool({
      id: 'cyclic.schema',
      description: 'Invalid.',
      input: cyclic as never,
      output: true,
    })).toThrow('must not contain cycles')

    const polluted = JSON.parse('{"__proto__":{"polluted":true}}') as Record<string, never>
    const descriptor = defineTool({
      id: 'safe.schema',
      description: 'Keep JSON keys inert.',
      input: polluted,
      output: true,
    })
    expect(Object.getPrototypeOf(descriptor.input)).toBe(Object.prototype)
    expect(Object.hasOwn(descriptor.input as object, '__proto__')).toBe(true)
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined()
  })
})

describe('Tool core', () => {
  it('binds an allowlist and validates input and output', async () => {
    const ctx = new Context()
    let receivedInput: JsonValue | undefined

    try {
      await ctx.plugin(ToolCore)
      await ctx.plugin(toolPlugin({
        descriptor: definition('math.double'),
        async invoke(input) {
          receivedInput = input
          const value = (input as { readonly value: number }).value
          return { doubled: value * 2 }
        },
      }))

      const tools = ctx.tools.bind(['math.double'])
      await expect(tools.invoke({ id: 'math.double', input: { value: 4 } })).resolves.toEqual({ doubled: 8 })
      expect(Object.isFrozen(receivedInput)).toBe(true)
      expect(tools.descriptors).toEqual([expect.objectContaining({ id: 'math.double', version: '1' })])
      await expect(tools.invoke({ id: 'math.double', input: { value: 'four' } as never }))
        .rejects.toMatchObject({ code: 'INVALID_INPUT' })
      await expect(tools.invoke({ id: 'math.hidden', input: null }))
        .rejects.toMatchObject({ code: 'NOT_ALLOWED' })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('rejects unknown allowlist entries, duplicate providers, and invalid output', async () => {
    const ctx = new Context()

    try {
      await ctx.plugin(ToolCore)
      await ctx.plugin(toolPlugin({
        descriptor: definition('math.double'),
        async invoke() {
          return { doubled: 'invalid' }
        },
      }))

      expect(() => ctx.tools.bind(['missing.tool'])).toThrow(expect.objectContaining<Partial<ToolError>>({
        code: 'UNKNOWN_TOOL',
      }))
      expect(() => ctx.tools.bind(['math.double', 'math.double'])).toThrow(expect.objectContaining<Partial<ToolError>>({
        code: 'INVALID_REQUEST',
      }))
      const duplicate = ctx.plugin(toolPlugin({
        descriptor: definition('math.double'),
        async invoke() {
          return { doubled: 2 }
        },
      }))
      await expect(duplicate).rejects.toThrow('already registered')

      await expect(ctx.tools.bind(['math.double']).invoke({ id: 'math.double', input: { value: 1 } }))
        .rejects.toMatchObject({ code: 'INVALID_OUTPUT' })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('removes disposed contributions and drains active invocations', async () => {
    const ctx = new Context()
    const started = Promise.withResolvers<void>()
    const finish = Promise.withResolvers<void>()

    try {
      await ctx.plugin(ToolCore)
      const provider = ctx.plugin(toolPlugin({
        descriptor: definition('math.double'),
        async invoke(input) {
          started.resolve()
          await finish.promise
          return { doubled: (input as { readonly value: number }).value * 2 }
        },
      }))
      await provider
      const tools = ctx.tools.bind(['math.double'])
      const invocation = tools.invoke({ id: 'math.double', input: { value: 3 } })
      await started.promise

      let disposed = false
      const disposal = provider.dispose().then(() => {
        disposed = true
      })
      await Promise.resolve()
      expect(ctx.tools.list()).toEqual([])
      expect(disposed).toBe(false)

      finish.resolve()
      await expect(invocation).resolves.toEqual({ doubled: 6 })
      await disposal
      await expect(tools.invoke({ id: 'math.double', input: { value: 2 } }))
        .rejects.toMatchObject({ code: 'UNAVAILABLE' })
    } finally {
      finish.resolve()
      await ctx.fiber.dispose()
    }
  })

  it('forwards cancellation and rejects non-JSON boundary values', async () => {
    const ctx = new Context()

    try {
      await ctx.plugin(ToolCore)
      await ctx.plugin(toolPlugin({
        descriptor: {
          id: 'data.echo',
          description: 'Echo JSON data.',
          input: true,
          output: true,
        },
        async invoke(input) {
          return input
        },
      }))
      await ctx.plugin(toolPlugin({
        descriptor: {
          id: 'data.invalid-output',
          description: 'Return invalid data.',
          input: true,
          output: true,
        },
        async invoke() {
          return new Date()
        },
      }))
      const tools = ctx.tools.bind(['data.echo', 'data.invalid-output'])
      const controller = new AbortController()
      controller.abort(new Error('caller cancelled'))

      await expect(tools.invoke({ id: 'data.echo', input: null }, { signal: controller.signal }))
        .rejects.toMatchObject({ code: 'ABORTED' })
      await expect(tools.invoke({ id: 'data.echo', input: new Date() as never }))
        .rejects.toMatchObject({ code: 'INVALID_INPUT' })
      await expect(tools.invoke({ id: 'data.invalid-output', input: null }))
        .rejects.toMatchObject({ code: 'INVALID_OUTPUT' })

      const dangerousInput = JSON.parse('{"__proto__":{"polluted":true}}') as JsonValue
      const result = await tools.invoke({ id: 'data.echo', input: dangerousInput })
      expect(Object.getPrototypeOf(result)).toBe(Object.prototype)
      expect(Object.hasOwn(result as object, '__proto__')).toBe(true)
      expect(({} as { polluted?: boolean }).polluted).toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

function definition(id: string) {
  return {
    id,
    description: 'Double one integer.',
    input: inputSchema,
    output: outputSchema,
  }
}

function toolPlugin(contribution: ToolContribution) {
  return {
    name: `test-tool-${contribution.descriptor.id}`,
    inject: ['tools'],
    apply(ctx: Context) {
      ctx.tools.register(contribution)
    },
  }
}
