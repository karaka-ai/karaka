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
}

describe('OpenAI model provider', () => {
  it('maps Karaka messages to a stateless Responses API call and reports exact spend', async () => {
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
      store: false,
      stream: false,
      input: request.messages,
    })
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

  it('rejects incomplete responses and streams without a completion event', async () => {
    const incomplete = new OpenAIModelProvider(config, clientWith({
      async generate() {
        return { ...response('partial'), status: 'incomplete' }
      },
    }))
    await expect(incomplete.generate(request)).rejects.toThrow('did not complete (incomplete)')

    const truncated = new OpenAIModelProvider(config, clientWith({
      async *stream() {
        yield event({ type: 'response.output_text.delta', delta: 'partial' })
      },
    }))
    await expect(async () => {
      for await (const _event of truncated.stream!(request)) void _event
    }).rejects.toThrow('ended without completion')
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

function event(value: Partial<ResponseStreamEvent> & { type: ResponseStreamEvent['type'] }) {
  return value as ResponseStreamEvent
}
