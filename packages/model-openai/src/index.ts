import type { ModelGeneration, ModelProvider, ModelRequest } from '@karaka/agent-runtime'
import type { Context } from '@karaka/cordis'
import Schema from '@karaka/schemastery'
import OpenAI from 'openai'
import type {
  Response,
  ResponseCreateParamsNonStreaming,
  ResponseCreateParamsStreaming,
  ResponseStreamEvent,
  ResponseUsage,
} from 'openai/resources/responses/responses'

/** Exact rates expressed as spend-unit atoms per one million tokens. */
export interface PricingConfig {
  unit?: string
  inputPerMillion: string
  cachedInputPerMillion: string
  /** Omit to charge cache writes at the normal input rate. */
  cacheWritePerMillion?: string
  outputPerMillion: string
}

/** YAML-serializable OpenAI Responses API configuration. */
export interface Config {
  id: string
  model: string
  apiKey?: string
  baseURL?: string
  organization?: string
  project?: string
  maxOutputTokens?: number
  timeoutMs?: number
  maxRetries?: number
  pricing: PricingConfig
}

const PricingConfig: Schema<PricingConfig> = Schema.object({
  unit: Schema.string().default('USD_MICRO'),
  inputPerMillion: Schema.string().required(),
  cachedInputPerMillion: Schema.string().required(),
  cacheWritePerMillion: Schema.string(),
  outputPerMillion: Schema.string().required(),
})

export const Config: Schema<Config> = Schema.object({
  id: Schema.string().required(),
  model: Schema.string().required(),
  apiKey: Schema.string(),
  baseURL: Schema.string(),
  organization: Schema.string(),
  project: Schema.string(),
  maxOutputTokens: Schema.natural().min(1),
  timeoutMs: Schema.natural().min(1),
  maxRetries: Schema.natural(),
  pricing: PricingConfig.required(),
})

/** Narrow client surface used by the provider and replaceable in tests. */
export interface OpenAIResponsesClient {
  create(
    body: ResponseCreateParamsNonStreaming,
    options?: { signal?: AbortSignal },
  ): Promise<Response>
  create(
    body: ResponseCreateParamsStreaming,
    options?: { signal?: AbortSignal },
  ): Promise<AsyncIterable<ResponseStreamEvent>>
}

interface ParsedPricing {
  readonly unit: string
  readonly inputPerMillion: bigint
  readonly cachedInputPerMillion: bigint
  readonly cacheWritePerMillion?: bigint
  readonly outputPerMillion: bigint
}

/** OpenAI Responses API model implementation. */
export class OpenAIModelProvider implements ModelProvider {
  readonly id: string
  readonly spendUnit: string

  private readonly model: string
  private readonly maxOutputTokens: number | undefined
  private readonly pricing: ParsedPricing
  private readonly client: OpenAIResponsesClient

  constructor(config: Config, client?: OpenAIResponsesClient) {
    this.id = requireText(config.id, 'model ID')
    this.model = requireText(config.model, 'OpenAI model')
    this.maxOutputTokens = optionalPositiveInteger(config.maxOutputTokens, 'maximum output tokens')
    this.pricing = parsePricing(config.pricing)
    this.spendUnit = this.pricing.unit
    this.client = client ?? new OpenAI({
      ...(config.apiKey === undefined ? {} : { apiKey: requireText(config.apiKey, 'OpenAI API key') }),
      ...(config.baseURL === undefined ? {} : { baseURL: requireText(config.baseURL, 'OpenAI base URL') }),
      ...(config.organization === undefined
        ? {}
        : { organization: requireText(config.organization, 'OpenAI organization') }),
      ...(config.project === undefined ? {} : { project: requireText(config.project, 'OpenAI project') }),
      ...(config.timeoutMs === undefined ? {} : { timeout: positiveInteger(config.timeoutMs, 'OpenAI timeout') }),
      ...(config.maxRetries === undefined ? {} : { maxRetries: naturalInteger(config.maxRetries, 'OpenAI retries') }),
    }).responses
  }

  async generate(request: Readonly<ModelRequest>): Promise<ModelGeneration> {
    const response = await this.client.create({
      model: this.model,
      input: modelInput(request),
      store: false,
      stream: false,
      ...(this.maxOutputTokens === undefined ? {} : { max_output_tokens: this.maxOutputTokens }),
    }, request.signal ? { signal: request.signal } : undefined)

    return generation(responseContent(response), response, this.pricing)
  }

  async *stream(request: Readonly<ModelRequest>) {
    const events = await this.client.create({
      model: this.model,
      input: modelInput(request),
      store: false,
      stream: true,
      ...(this.maxOutputTokens === undefined ? {} : { max_output_tokens: this.maxOutputTokens }),
    }, request.signal ? { signal: request.signal } : undefined)

    let completed: Response | undefined
    let content = ''
    for await (const event of events) {
      if (event.type === 'response.output_text.delta' || event.type === 'response.refusal.delta') {
        content += event.delta
        if (event.delta) yield { type: 'text-delta' as const, delta: event.delta }
      } else if (event.type === 'response.completed') {
        if (completed) throw new Error('OpenAI streamed more than one completed response')
        completed = event.response
      }
    }

    if (!completed) throw new Error('OpenAI response stream ended without completion')
    const completedContent = responseContent(completed)
    if (content !== completedContent) {
      throw new Error('OpenAI response stream did not match its completed output')
    }
    yield { type: 'completed' as const, generation: generation(completedContent, completed, this.pricing) }
  }
}

/** Contribute one configured OpenAI model to the caller's Cordis model scope. */
export const plugin = {
  name: 'model-openai',
  inject: ['agentModels'],
  Config,
  apply(ctx: Context, config: Config) {
    ctx.agentModels.register(new OpenAIModelProvider(config))
  },
}

function modelInput(request: Readonly<ModelRequest>) {
  if (!Array.isArray(request.messages) || !request.messages.length) {
    throw new TypeError('model messages must be a non-empty array')
  }
  return request.messages.map(message => ({
    role: message.role,
    content: message.content,
  }))
}

function responseContent(response: Response) {
  const content: string[] = []
  let foundContent = false

  for (const item of response.output) {
    if (item.type !== 'message') continue
    for (const part of item.content) {
      foundContent = true
      content.push(part.type === 'output_text' ? part.text : part.refusal)
    }
  }

  return foundContent ? content.join('') : response.output_text
}

function generation(content: string, response: Response, pricing: ParsedPricing): ModelGeneration {
  if (response.status !== 'completed') {
    throw new Error(`OpenAI response did not complete${response.status ? ` (${response.status})` : ''}`)
  }
  if (typeof content !== 'string') throw new Error('OpenAI response contained no text output')
  if (!response.usage) throw new Error('OpenAI response contained no token usage')

  return Object.freeze({
    message: Object.freeze({ role: 'assistant' as const, content }),
    spend: Object.freeze({ unit: pricing.unit, amount: calculateSpend(response.usage, pricing) }),
  })
}

function calculateSpend(usage: ResponseUsage, pricing: ParsedPricing) {
  const input = tokenCount(usage.input_tokens, 'input tokens')
  const output = tokenCount(usage.output_tokens, 'output tokens')
  const cached = tokenCount(usage.input_tokens_details?.cached_tokens, 'cached input tokens')
  const cacheWrite = tokenCount(usage.input_tokens_details?.cache_write_tokens ?? 0, 'cache-write input tokens')
  const separatelyPricedCacheWrite = pricing.cacheWritePerMillion === undefined ? 0n : cacheWrite
  const ordinaryInput = input - cached - separatelyPricedCacheWrite
  if (ordinaryInput < 0n) throw new Error('OpenAI response contained inconsistent input-token usage')

  const numerator = ordinaryInput * pricing.inputPerMillion
    + cached * pricing.cachedInputPerMillion
    + separatelyPricedCacheWrite * (pricing.cacheWritePerMillion ?? 0n)
    + output * pricing.outputPerMillion
  return divideRoundingUp(numerator, 1_000_000n)
}

function parsePricing(config: PricingConfig): ParsedPricing {
  if (!config || typeof config !== 'object') throw new TypeError('OpenAI pricing is required')
  const cacheWritePerMillion = config.cacheWritePerMillion === undefined
    ? undefined
    : amount(config.cacheWritePerMillion, 'cache-write input price')
  return Object.freeze({
    unit: requireText(config.unit ?? 'USD_MICRO', 'spend unit'),
    inputPerMillion: amount(config.inputPerMillion, 'input price'),
    cachedInputPerMillion: amount(config.cachedInputPerMillion, 'cached input price'),
    ...(cacheWritePerMillion === undefined ? {} : { cacheWritePerMillion }),
    outputPerMillion: amount(config.outputPerMillion, 'output price'),
  })
}

function amount(value: string, label: string) {
  if (!/^\d+$/.test(value)) throw new TypeError(`${label} must be a non-negative integer string`)
  return BigInt(value)
}

function tokenCount(value: unknown, label: string) {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`OpenAI response contained invalid ${label}`)
  }
  return BigInt(value as number)
}

function divideRoundingUp(numerator: bigint, denominator: bigint) {
  return numerator === 0n ? 0n : (numerator + denominator - 1n) / denominator
}

function requireText(value: unknown, label: string): string {
  if (typeof value === 'string' && value.trim()) return value
  throw new TypeError(`${label} must be a non-empty string`)
}

function optionalPositiveInteger(value: number | undefined, label: string) {
  return value === undefined ? undefined : positiveInteger(value, label)
}

function positiveInteger(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${label} must be a positive integer`)
  return value
}

function naturalInteger(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} must be a non-negative integer`)
  return value
}

export default plugin
