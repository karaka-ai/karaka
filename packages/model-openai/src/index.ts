import type {
  ModelConversationItem,
  ModelGeneration,
  ModelProviderData,
  ModelProvider,
  ModelRequest,
  ModelToolCall,
} from '@karaka/agent-runtime'
import type { Context } from '@karaka/cordis'
import Schema from '@karaka/schemastery'
import type { JsonValue, ToolDescriptor } from '@karaka/sdk/tool'
import OpenAI from 'openai'
import { createHash } from 'node:crypto'
import type {
  FunctionTool,
  Response,
  ResponseCreateParamsNonStreaming,
  ResponseCreateParamsStreaming,
  ResponseInputItem,
  ResponseOutputMessage,
  ResponseStreamEvent,
  ResponseUsage,
  ServiceTier,
} from 'openai/resources/responses/responses'

const OPENAI_RESPONSES_PROVIDER = 'openai.responses'

/** Configured rates expressed as spend-unit atoms per one million tokens. */
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
  /** Explicit OpenAI processing tier. Defaults to standard processing. */
  serviceTier?: Exclude<ServiceTier, null>
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

const serviceTiers = [
  'auto',
  'default',
  'flex',
  'scale',
  'priority',
  'fast',
  'ultrafast',
] as const satisfies readonly Exclude<ServiceTier, null>[]

const ServiceTierConfig: Schema<Exclude<ServiceTier, null>> = Schema.union([...serviceTiers]).default('default')

export const Config: Schema<Config> = Schema.object({
  id: Schema.string().required(),
  model: Schema.string().required(),
  serviceTier: ServiceTierConfig,
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

interface OpenAIToolSet {
  readonly definitions: FunctionTool[]
  readonly logicalIds: ReadonlyMap<string, string>
}

/** OpenAI Responses API model implementation. */
export class OpenAIModelProvider implements ModelProvider {
  readonly id: string
  readonly spendUnit: string

  private readonly model: string
  private readonly serviceTier: Exclude<ServiceTier, null>
  private readonly maxOutputTokens: number | undefined
  private readonly pricing: ParsedPricing
  private readonly client: OpenAIResponsesClient
  private readonly toolSets = new WeakMap<readonly ToolDescriptor[], OpenAIToolSet>()

  constructor(config: Config, client?: OpenAIResponsesClient) {
    this.id = requireText(config.id, 'model ID')
    this.model = requireText(config.model, 'OpenAI model')
    this.serviceTier = serviceTier(config.serviceTier)
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

  validateTools(tools: readonly ToolDescriptor[]): void {
    this.toolSet(tools)
  }

  async generate(request: Readonly<ModelRequest>): Promise<ModelGeneration> {
    const tools = this.toolSet(request.tools)
    const response = await this.client.create({
      model: this.model,
      input: modelInput(request),
      service_tier: this.serviceTier,
      include: ['reasoning.encrypted_content'],
      store: false,
      stream: false,
      ...(tools.definitions.length ? { tools: tools.definitions, parallel_tool_calls: false } : {}),
      ...(this.maxOutputTokens === undefined ? {} : { max_output_tokens: this.maxOutputTokens }),
    }, request.signal ? { signal: request.signal } : undefined)

    return generation(responseContent(response), response, this.pricing, tools.logicalIds)
  }

  async *stream(request: Readonly<ModelRequest>) {
    const tools = this.toolSet(request.tools)
    const events = await this.client.create({
      model: this.model,
      input: modelInput(request),
      service_tier: this.serviceTier,
      include: ['reasoning.encrypted_content'],
      store: false,
      stream: true,
      ...(tools.definitions.length ? { tools: tools.definitions, parallel_tool_calls: false } : {}),
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
      } else if (event.type === 'error') {
        throw streamError(event.code, event.message, event.param)
      } else if (event.type === 'response.failed') {
        throw failedResponseError(event.response)
      } else if (event.type === 'response.incomplete') {
        throw incompleteResponseError(event.response)
      }
    }

    if (!completed) throw new Error('OpenAI response stream ended without completion')
    const completedContent = responseContent(completed)
    if (content !== completedContent) {
      throw new Error('OpenAI response stream did not match its completed output')
    }
    yield {
      type: 'completed' as const,
      generation: generation(completedContent, completed, this.pricing, tools.logicalIds),
    }
  }

  private toolSet(tools: readonly ToolDescriptor[]): OpenAIToolSet {
    const existing = this.toolSets.get(tools)
    if (existing) return existing
    const prepared = openAITools(tools)
    this.toolSets.set(tools, prepared)
    return prepared
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

function modelInput(request: Readonly<ModelRequest>): ResponseInputItem[] {
  if (!Array.isArray(request.messages) || !request.messages.length) {
    throw new TypeError('model messages must be a non-empty array')
  }
  return request.messages.flatMap(item => {
    const mapped = modelInputItem(item)
    return mapped ? [mapped] : []
  })
}

function modelInputItem(item: ModelConversationItem): ResponseInputItem | undefined {
  if ('type' in item && item.type === 'provider-item') {
    return item.providerData.provider === OPENAI_RESPONSES_PROVIDER
      ? providerInputItem(item.providerData)
      : undefined
  }
  if (
    'providerData' in item
    && item.providerData?.provider === OPENAI_RESPONSES_PROVIDER
  ) {
    return providerInputItem(item.providerData)
  }
  if (!('type' in item)) return { role: item.role, content: item.content }
  const name = openAIToolName(item.toolId)
  if (item.type === 'tool-call') {
    return {
      type: 'function_call',
      call_id: item.callId,
      name,
      arguments: JSON.stringify(item.input),
    }
  }
  return {
    type: 'function_call_output',
    call_id: item.callId,
    name,
    output: JSON.stringify(item.output),
  }
}

function providerInputItem(data: ModelProviderData): ResponseInputItem {
  if (!data.value || typeof data.value !== 'object' || Array.isArray(data.value)) {
    throw new TypeError('OpenAI replay item must be an object')
  }
  return data.value as unknown as ResponseInputItem
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

function generation(
  content: string,
  response: Response,
  pricing: ParsedPricing,
  logicalIds: ReadonlyMap<string, string>,
): ModelGeneration {
  if (response.status === 'failed') throw failedResponseError(response)
  if (response.status === 'incomplete') throw incompleteResponseError(response)
  if (response.status !== 'completed') {
    throw new Error(`OpenAI response did not complete${response.status ? ` (${response.status})` : ''}`)
  }
  if (typeof content !== 'string') throw new Error('OpenAI response contained no text output')
  if (!response.usage) throw new Error('OpenAI response contained no token usage')

  const output = responseReplay(response, logicalIds)
  return Object.freeze({
    message: Object.freeze({ role: 'assistant' as const, content }),
    ...(output.toolCalls.length ? { toolCalls: output.toolCalls } : {}),
    replay: output.replay,
    spend: Object.freeze({ unit: pricing.unit, amount: calculateSpend(response.usage, pricing) }),
  })
}

function openAITools(tools: readonly ToolDescriptor[]): OpenAIToolSet {
  if (!Array.isArray(tools)) throw new TypeError('model tools must be an array')
  const logicalIds = new Map<string, string>()
  const definitions: FunctionTool[] = tools.map(tool => {
    if (!tool || typeof tool !== 'object' || typeof tool.id !== 'string') {
      throw new TypeError('model tool descriptor is invalid')
    }
    if (!isObjectSchema(tool.input)) {
      throw new TypeError(`OpenAI tool "${tool.id}" requires an object input schema`)
    }
    const name = openAIToolName(tool.id)
    if (logicalIds.has(name)) throw new TypeError(`OpenAI tool name collision for "${tool.id}"`)
    logicalIds.set(name, tool.id)
    return Object.freeze({
      type: 'function' as const,
      name,
      description: `[${tool.id}] ${tool.description}`,
      parameters: tool.input,
      strict: false,
    })
  })
  return Object.freeze({
    definitions,
    logicalIds,
  })
}

function openAIToolName(id: string) {
  const readable = id.replaceAll('.', '_').slice(0, 18)
  const digest = createHash('sha256').update(id).digest('base64url')
  return `k_${readable}_${digest}`
}

function responseReplay(response: Response, logicalIds: ReadonlyMap<string, string>) {
  const replay = []
  const toolCalls: ModelToolCall[] = []
  for (const item of response.output) {
    if (item.type === 'message') {
      replay.push(Object.freeze({
        role: 'assistant' as const,
        content: responseMessageContent(item),
        providerData: responseItemData(item),
      }))
      continue
    }
    if (item.type === 'reasoning') {
      replay.push(Object.freeze({
        type: 'provider-item' as const,
        providerData: responseItemData(item),
      }))
      continue
    }
    if (item.type !== 'function_call') {
      throw new Error(`OpenAI returned unsupported output item "${diagnostic(item.type)}"`)
    }
    if (item.status !== undefined && item.status !== 'completed') {
      throw new Error(`OpenAI tool call "${diagnostic(item.call_id)}" did not complete`)
    }
    const toolId = logicalIds.get(item.name)
    if (!toolId) throw new Error(`OpenAI requested unknown tool "${diagnostic(item.name)}"`)
    let input: unknown
    try {
      input = JSON.parse(item.arguments)
    } catch (cause) {
      throw new Error(`OpenAI tool "${toolId}" returned invalid JSON arguments`, { cause })
    }
    const call = Object.freeze({
      type: 'tool-call' as const,
      callId: requireText(item.call_id, 'OpenAI tool call ID'),
      toolId,
      input: input as JsonValue,
      providerData: responseItemData(item),
    })
    toolCalls.push(call)
    replay.push(call)
  }
  return Object.freeze({ replay: Object.freeze(replay), toolCalls: Object.freeze(toolCalls) })
}

function responseMessageContent(message: ResponseOutputMessage) {
  return message.content.map(part => part.type === 'output_text' ? part.text : part.refusal).join('')
}

function responseItemData(item: Response['output'][number]): ModelProviderData {
  return Object.freeze({
    provider: OPENAI_RESPONSES_PROVIDER,
    value: JSON.parse(JSON.stringify(item)) as JsonValue,
  })
}

function isObjectSchema(value: ToolDescriptor['input']): value is { readonly [key: string]: JsonValue } {
  return !!value
    && typeof value === 'object'
    && !Array.isArray(value)
    && value.type === 'object'
}

function calculateSpend(usage: ResponseUsage, pricing: ParsedPricing) {
  const input = tokenCount(usage.input_tokens, 'input tokens')
  const output = tokenCount(usage.output_tokens, 'output tokens')
  const total = tokenCount(usage.total_tokens, 'total tokens')
  const cached = tokenCount(usage.input_tokens_details?.cached_tokens, 'cached input tokens')
  const cacheWrite = tokenCount(usage.input_tokens_details?.cache_write_tokens, 'cache-write input tokens')
  const reasoning = tokenCount(usage.output_tokens_details?.reasoning_tokens, 'reasoning output tokens')
  if (total !== input + output) throw new Error('OpenAI response contained inconsistent total-token usage')
  if (cached + cacheWrite > input) throw new Error('OpenAI response contained inconsistent input-token usage')
  if (reasoning > output) throw new Error('OpenAI response contained inconsistent output-token usage')

  const separatelyPricedCacheWrite = pricing.cacheWritePerMillion === undefined ? 0n : cacheWrite
  const ordinaryInput = input - cached - separatelyPricedCacheWrite

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

function amount(value: unknown, label: string) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new TypeError(`${label} must be a non-negative integer string`)
  }
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

function streamError(code: string | null, message: string, parameter: string | null) {
  const safeParameter = diagnostic(parameter)
  const details = [
    diagnostic(code),
    safeParameter ? `parameter ${safeParameter}` : '',
  ].filter(Boolean).join(', ')
  return new Error(`OpenAI response stream failed${details ? ` (${details})` : ''}: ${diagnostic(message)}`)
}

function failedResponseError(response: Response) {
  const code = diagnostic(response.error?.code)
  const message = diagnostic(response.error?.message)
  return new Error(`OpenAI response failed${code ? ` (${code})` : ''}${message ? `: ${message}` : ''}`)
}

function incompleteResponseError(response: Response) {
  const reason = diagnostic(response.incomplete_details?.reason)
  return new Error(`OpenAI response incomplete${reason ? ` (${reason})` : ''}`)
}

function diagnostic(value: unknown) {
  if (typeof value !== 'string') return ''
  const text = Array.from(value, character => {
    const code = character.codePointAt(0)!
    return isDiagnosticControl(code) ? ' ' : character
  }).join('').trim()
  return text.length > 500 ? `${text.slice(0, 497)}...` : text
}

function isDiagnosticControl(code: number) {
  return code <= 31
    || (code >= 127 && code <= 159)
    || code === 0x061c
    || code === 0x200e
    || code === 0x200f
    || code === 0x2028
    || code === 0x2029
    || (code >= 0x202a && code <= 0x202e)
    || (code >= 0x2066 && code <= 0x2069)
}

function serviceTier(value: Config['serviceTier']) {
  const selected = value ?? 'default'
  if (serviceTiers.includes(selected)) return selected
  throw new TypeError('OpenAI service tier is invalid')
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
