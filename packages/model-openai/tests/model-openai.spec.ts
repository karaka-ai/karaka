import AgentRuntime, { AgentModelsService, type ModelRequest } from '@karaka/agent-runtime'
import { Context } from '@karaka/cordis'
import Entitlement from '@karaka/entitlement'
import EntitlementLocal from '@karaka/entitlement/local'
import OpenAIModel, {
  OpenAIModelProvider,
  type Config,
  type OpenAIResponsesClient,
} from '@karaka/model-openai'
import type {
  Response,
  ResponseCreateParamsNonStreaming,
  ResponseCreateParamsStreaming,
  ResponseOutputRefusal,
  ResponseOutputText,
  ResponseStreamEvent,
} from 'openai/resources/responses/responses'
import { describe, expect, it } from 'vitest'

const config: Config = {
  id: 'support-model',
  model: 'gpt-test',
  pricing: {
    unit: 'USD_MICRO',
    inputPerMillion: '1000000',
    cachedInputPerMillion: '100000',
    cacheWritePerMillion: '2000000',
    outputPerMillion: '4000000',
  },
}

const request: ModelRequest = {
  agentId: 'support',
  messages: [
    { role: 'system', content: 'Be helpful.' },
    { role: 'user', content: 'Hello' },
  ],
  tools: [],
}

describe('OpenAI model provider', () => {
  it('maps Karaka messages to a stateless Responses API call and reports configured spend', async () => {
    let received: ResponseCreateParamsNonStreaming | undefined
    const client = clientWith({
      async generate(body) {
        received = body
        return response('Hello back', {
          input_tokens: 100,
          input_tokens_details: { cached_tokens: 20, cache_write_tokens: 10 },
          output_tokens: 5,
          output_tokens_details: { reasoning_tokens: 2 },
          total_tokens: 105,
        })
      },
    })
    const provider = new OpenAIModelProvider(config, client)

    await expect(provider.generate(request)).resolves.toEqual({
      message: { role: 'assistant', content: 'Hello back' },
      spend: { unit: 'USD_MICRO', amount: 112n },
    })
    expect(received).toMatchObject({
      model: 'gpt-test',
      service_tier: 'default',
      store: false,
      stream: false,
      input: request.messages,
    })
  })

  it('maps validated logical tools and function-call history in both directions', async () => {
    const bodies: ResponseCreateParamsNonStreaming[] = []
    const client = clientWith({
      async generate(body) {
        bodies.push(body)
        return bodies.length === 1
          ? responseWithToolCall(
              'call-1',
              functionToolName(body),
              '{"invoiceId":"inv-1"}',
            )
          : response('Refunded.')
      },
    })
    const provider = new OpenAIModelProvider(config, client)
    const tool = {
      id: 'invoices.refund',
      version: '1',
      description: 'Refund one invoice.',
      input: {
        type: 'object',
        properties: { invoiceId: { type: 'string' } },
        required: ['invoiceId'],
        additionalProperties: false,
      },
      output: {
        type: 'object',
        properties: { refunded: { type: 'boolean' } },
        required: ['refunded'],
        additionalProperties: false,
      },
    } as const
    provider.validateTools([tool])

    const first = await provider.generate({ ...request, tools: [tool] })
    expect(first).toMatchObject({
      message: { role: 'assistant', content: '' },
      toolCalls: [{
        type: 'tool-call',
        callId: 'call-1',
        toolId: 'invoices.refund',
        input: { invoiceId: 'inv-1' },
      }],
    })
    expect(bodies[0]).toMatchObject({
      parallel_tool_calls: false,
      tools: [{
        type: 'function',
        name: expect.stringMatching(/^k_invoices_refund_/),
        description: '[invoices.refund] Refund one invoice.',
      }],
    })
    const providerName = functionToolName(bodies[0]!)

    await provider.generate({
      ...request,
      tools: [tool],
      messages: [
        ...request.messages,
        first.toolCalls![0]!,
        {
          type: 'tool-result',
          callId: 'call-1',
          toolId: 'invoices.refund',
          output: { refunded: true },
        },
      ],
    })
    expect(bodies[1]?.input).toEqual([
      ...request.messages,
      {
        type: 'function_call',
        call_id: 'call-1',
        name: providerName,
        arguments: '{"invoiceId":"inv-1"}',
      },
      {
        type: 'function_call_output',
        call_id: 'call-1',
        name: providerName,
        output: '{"refunded":true}',
      },
    ])

    expect(() => provider.validateTools([{ ...tool, input: true }]))
      .toThrow('requires an object input schema')
  })

  it('forwards cancellation and converts OpenAI text events to Agent Runtime streaming', async () => {
    const controller = new AbortController()
    let observedSignal: AbortSignal | undefined
    const client = clientWith({
      async *stream(_body, signal) {
        observedSignal = signal
        yield event({ type: 'response.output_text.delta', delta: 'Hello ' })
        yield event({ type: 'response.output_text.delta', delta: 'back' })
        yield event({ type: 'response.completed', response: response('Hello back') })
      },
    })
    const provider = new OpenAIModelProvider(config, client)

    const events = []
    for await (const item of provider.stream!({ ...request, signal: controller.signal })) events.push(item)

    expect(observedSignal).toBe(controller.signal)
    expect(events).toEqual([
      { type: 'text-delta', delta: 'Hello ' },
      { type: 'text-delta', delta: 'back' },
      {
        type: 'completed',
        generation: {
          message: { role: 'assistant', content: 'Hello back' },
          spend: { unit: 'USD_MICRO', amount: 5n },
        },
      },
    ])
  })

  it('passes the configured service tier to completed and streamed calls', async () => {
    const bodies: Array<ResponseCreateParamsNonStreaming | ResponseCreateParamsStreaming> = []
    const client = clientWith({
      async generate(body) {
        bodies.push(body)
        return response('completed')
      },
      async *stream(body) {
        bodies.push(body)
        yield event({ type: 'response.completed', response: response('') })
      },
    })
    const provider = new OpenAIModelProvider({ ...config, serviceTier: 'flex' }, client)

    await provider.generate(request)
    for await (const _event of provider.stream!(request)) void _event

    expect(bodies.map(body => body.service_tier)).toEqual(['flex', 'flex'])
  })

  it('preserves refusal content in completed and streamed generations', async () => {
    const refusal = 'I cannot help with that.'
    const completed = new OpenAIModelProvider(config, clientWith({
      async generate() {
        return responseWithContent('', [{ type: 'refusal', refusal }])
      },
    }))
    await expect(completed.generate(request)).resolves.toMatchObject({
      message: { role: 'assistant', content: refusal },
    })

    const streamed = new OpenAIModelProvider(config, clientWith({
      async *stream() {
        yield event({ type: 'response.refusal.delta', delta: 'I cannot ' })
        yield event({ type: 'response.refusal.delta', delta: 'help with that.' })
        yield event({
          type: 'response.completed',
          response: responseWithContent('', [{ type: 'refusal', refusal }]),
        })
      },
    }))

    const events = []
    for await (const item of streamed.stream!(request)) events.push(item)
    expect(events).toEqual([
      { type: 'text-delta', delta: 'I cannot ' },
      { type: 'text-delta', delta: 'help with that.' },
      {
        type: 'completed',
        generation: {
          message: { role: 'assistant', content: refusal },
          spend: { unit: 'USD_MICRO', amount: 5n },
        },
      },
    ])
  })

  it('rejects streamed text that differs from the completed response output', async () => {
    const provider = new OpenAIModelProvider(config, clientWith({
      async *stream() {
        yield event({ type: 'response.output_text.delta', delta: 'partial' })
        yield event({ type: 'response.completed', response: response('different') })
      },
    }))

    await expect(async () => {
      for await (const _event of provider.stream!(request)) void _event
    }).rejects.toThrow('did not match its completed output')
  })

  it('preserves bounded diagnostics for failed and incomplete responses', async () => {
    const failed = new OpenAIModelProvider(config, clientWith({
      async generate() {
        return {
          ...response(''),
          status: 'failed',
          error: {
            code: 'server_error',
            message: `Provider\u0085unavailable\u2028detail\u2029next\u202Ehidden\u2066isolate\u061Cend${'!'.repeat(600)}`,
          },
        }
      },
    }))
    await expect(failed.generate(request)).rejects.toThrow(
      `OpenAI response failed (server_error): Provider unavailable detail next hidden isolate end${'!'.repeat(446)}...`,
    )

    const incomplete = new OpenAIModelProvider(config, clientWith({
      async generate() {
        return {
          ...response('partial'),
          status: 'incomplete',
          incomplete_details: { reason: 'content_filter' },
        }
      },
    }))
    await expect(incomplete.generate(request)).rejects.toThrow('OpenAI response incomplete (content_filter)')
  })

  it('rejects streams without a completion event', async () => {
    const truncated = new OpenAIModelProvider(config, clientWith({
      async *stream() {
        yield event({ type: 'response.output_text.delta', delta: 'partial' })
      },
    }))
    await expect(async () => {
      for await (const _event of truncated.stream!(request)) void _event
    }).rejects.toThrow('ended without completion')
  })

  it('rejects non-string configured rates during direct construction', () => {
    const invalid = {
      ...config,
      pricing: { ...config.pricing, inputPerMillion: 1000000 },
    } as unknown as Config

    expect(() => new OpenAIModelProvider(invalid, clientWith({}))).toThrow(
      'input price must be a non-negative integer string',
    )
  })

  it.each([
    {
      name: 'error',
      events: [event({
        type: 'error',
        code: 'invalid_request',
        message: 'Bad\u200Erequest\u0085detail',
        param: 'input',
      })],
      message: 'OpenAI response stream failed (invalid_request, parameter input): Bad request detail',
    },
    {
      name: 'failed',
      events: [event({
        type: 'response.failed',
        response: {
          ...response(''),
          status: 'failed',
          error: { code: 'server_error', message: 'Provider unavailable' },
        },
      })],
      message: 'OpenAI response failed (server_error): Provider unavailable',
    },
    {
      name: 'incomplete',
      events: [event({
        type: 'response.incomplete',
        response: {
          ...response('partial'),
          status: 'incomplete',
          incomplete_details: { reason: 'max_output_tokens' },
        },
      })],
      message: 'OpenAI response incomplete (max_output_tokens)',
    },
  ])('rejects the OpenAI $name terminal stream event with diagnostics', async ({ events, message }) => {
    const provider = new OpenAIModelProvider(config, clientWith({
      async *stream() {
        yield* events
      },
    }))

    await expect(collect(provider.stream!(request))).rejects.toThrow(message)
  })

  it('propagates streaming cancellation without reporting completion', async () => {
    const controller = new AbortController()
    const provider = new OpenAIModelProvider(config, clientWith({
      async *stream(_body, signal) {
        yield event({ type: 'response.output_text.delta', delta: 'partial' })
        controller.abort()
        signal?.throwIfAborted()
      },
    }))

    await expect(collect(provider.stream!({ ...request, signal: controller.signal }))).rejects.toMatchObject({
      name: 'AbortError',
    })
  })

  it.each([
    {
      name: 'negative token count',
      usage: usage({ input_tokens: -1, total_tokens: 0 }),
      message: 'invalid input tokens',
    },
    {
      name: 'unsafe token count',
      usage: usage({ input_tokens: Number.MAX_SAFE_INTEGER + 1, total_tokens: Number.MAX_SAFE_INTEGER + 2 }),
      message: 'invalid input tokens',
    },
    {
      name: 'missing input breakdown',
      usage: usage({ input_tokens_details: undefined } as unknown as Partial<NonNullable<Response['usage']>>),
      message: 'invalid cached input tokens',
    },
    {
      name: 'inconsistent total',
      usage: usage({ total_tokens: 3 }),
      message: 'inconsistent total-token usage',
    },
    {
      name: 'inconsistent input breakdown',
      usage: usage({
        input_tokens_details: { cached_tokens: 1, cache_write_tokens: 1 },
      }),
      message: 'inconsistent input-token usage',
    },
    {
      name: 'inconsistent output breakdown',
      usage: usage({
        output_tokens_details: { reasoning_tokens: 2 },
      }),
      message: 'inconsistent output-token usage',
    },
  ])('rejects $name in OpenAI usage', async ({ usage, message }) => {
    const provider = new OpenAIModelProvider(config, clientWith({
      async generate() {
        return response('invalid', usage)
      },
    }))

    await expect(provider.generate(request)).rejects.toThrow(message)
  })

  it('rounds the aggregate configured charge up once per completed call', async () => {
    const roundingConfig: Config = {
      ...config,
      pricing: {
        unit: 'CREDIT_ATOM',
        inputPerMillion: '1',
        cachedInputPerMillion: '0',
        outputPerMillion: '0',
      },
    }
    const exact = new OpenAIModelProvider(roundingConfig, clientWith({
      async generate() {
        return response('', usage({ input_tokens: 1_000_000, output_tokens: 0, total_tokens: 1_000_000 }))
      },
    }))
    const rounded = new OpenAIModelProvider(roundingConfig, clientWith({
      async generate() {
        return response('', usage({ input_tokens: 1_000_001, output_tokens: 0, total_tokens: 1_000_001 }))
      },
    }))

    await expect(exact.generate(request)).resolves.toMatchObject({
      spend: { unit: 'CREDIT_ATOM', amount: 1n },
    })
    await expect(rounded.generate(request)).resolves.toMatchObject({
      spend: { unit: 'CREDIT_ATOM', amount: 2n },
    })
  })

  it('charges cache writes at the ordinary input rate when their rate is omitted', async () => {
    const provider = new OpenAIModelProvider({
      ...config,
      pricing: {
        unit: 'USD_MICRO',
        inputPerMillion: '1000000',
        cachedInputPerMillion: '100000',
        outputPerMillion: '0',
      },
    }, clientWith({
      async generate() {
        return response('', usage({
          input_tokens: 100,
          input_tokens_details: { cached_tokens: 20, cache_write_tokens: 10 },
          output_tokens: 0,
          total_tokens: 100,
        }))
      },
    }))

    await expect(provider.generate(request)).resolves.toMatchObject({
      spend: { unit: 'USD_MICRO', amount: 82n },
    })
  })

  it('registers and removes the provider through Cordis effects', async () => {
    const previousApiKey = process.env.OPENAI_API_KEY
    process.env.OPENAI_API_KEY = 'test-key'
    const ctx = new Context()

    try {
      await ctx.plugin(AgentModelsService)
      const fork = ctx.plugin(OpenAIModel, config)
      await fork
      expect(ctx.agentModels.list()).toEqual(['support-model'])
      await fork.dispose()
      expect(ctx.agentModels.list()).toEqual([])
    } finally {
      if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = previousApiKey
      await ctx.fiber.dispose()
    }
  })

  it('records OpenAI spend through Agent Runtime and Entitlement', async () => {
    const ctx = new Context()
    const provider = new OpenAIModelProvider(config, clientWith({
      async generate() {
        return response('Provider response')
      },
    }))

    try {
      await ctx.plugin(Entitlement)
      await ctx.plugin(EntitlementLocal, { defaultLimit: '100' })
      await ctx.plugin(AgentRuntime)
      await ctx.plugin({
        name: 'openai-runtime-integration',
        inject: ['agentRuntime', 'agentModels'],
        apply(pluginContext) {
          pluginContext.agentModels.register(provider)
          pluginContext.agentRuntime.registerAgent({
            id: 'support',
            prompt: 'Be helpful.',
            model: provider.id,
          }, pluginContext.agentModels)
        },
      })

      await expect(ctx.agentRuntime.run({
        agentId: 'support',
        message: 'Hello',
        entitlementAccount: 'developer',
      })).resolves.toMatchObject({
        model: 'support-model',
        message: { role: 'assistant', content: 'Provider response' },
      })
      await expect(ctx.entitlement.status('developer')).resolves.toMatchObject({
        unit: 'USD_MICRO',
        spent: 5n,
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

interface ClientBehavior {
  generate?(body: ResponseCreateParamsNonStreaming, signal?: AbortSignal): Promise<Response>
  stream?(
    body: ResponseCreateParamsStreaming,
    signal?: AbortSignal,
  ): AsyncIterable<ResponseStreamEvent>
}

function clientWith(behavior: ClientBehavior): OpenAIResponsesClient {
  return {
    create(body, options) {
      if (body.stream) {
        if (!behavior.stream) throw new Error('unexpected streaming call')
        return Promise.resolve(behavior.stream(body, options?.signal))
      }
      if (!behavior.generate) throw new Error('unexpected non-streaming call')
      return behavior.generate(body, options?.signal)
    },
  } as OpenAIResponsesClient
}

function response(outputText: string, usage: Response['usage'] = {
  input_tokens: 1,
  input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
  output_tokens: 1,
  output_tokens_details: { reasoning_tokens: 0 },
  total_tokens: 2,
}): Response {
  return responseWithContent(outputText, [{ type: 'output_text', text: outputText, annotations: [] }], usage)
}

function responseWithContent(
  outputText: string,
  content: Array<ResponseOutputText | ResponseOutputRefusal>,
  usage: Response['usage'] = {
    input_tokens: 1,
    input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
    output_tokens: 1,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: 2,
  },
): Response {
  return {
    id: 'response-test',
    object: 'response',
    created_at: 0,
    model: 'gpt-test',
    output_text: outputText,
    output: [{
      id: 'message-test',
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content,
    }],
    status: 'completed',
    error: null,
    incomplete_details: null,
    instructions: null,
    metadata: null,
    parallel_tool_calls: false,
    temperature: null,
    tool_choice: 'auto',
    tools: [],
    top_p: null,
    usage,
  }
}

function responseWithToolCall(callId: string, name: string, args: string): Response {
  return {
    ...response(''),
    output: [{
      type: 'function_call',
      call_id: callId,
      name,
      arguments: args,
      status: 'completed',
    }],
  }
}

function functionToolName(body: ResponseCreateParamsNonStreaming) {
  const tool = body.tools?.[0]
  if (tool?.type !== 'function') throw new Error('expected one OpenAI function tool')
  return tool.name
}

function event(value: Partial<ResponseStreamEvent> & { type: ResponseStreamEvent['type'] }) {
  return value as ResponseStreamEvent
}

function usage(overrides: Partial<NonNullable<Response['usage']>>): NonNullable<Response['usage']> {
  return {
    input_tokens: 1,
    input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
    output_tokens: 1,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: 2,
    ...overrides,
  } as NonNullable<Response['usage']>
}

async function collect(stream: AsyncIterable<unknown>) {
  const events = []
  for await (const event of stream) events.push(event)
  return events
}
