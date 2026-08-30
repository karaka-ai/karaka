import { AgentModelsService, type ModelRequest } from '@karaka/agent-runtime'
import { Context } from '@karaka/cordis'
import OpenAIModel, {
  OpenAIModelProvider,
  type Config,
  type OpenAIResponsesClient,
} from '@karaka/model-openai'
import type {
  Response,
  ResponseCreateParamsNonStreaming,
  ResponseCreateParamsStreaming,
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
  return {
    id: 'response-test',
    object: 'response',
    created_at: 0,
    model: 'gpt-test',
    output_text: outputText,
    output: [],
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
