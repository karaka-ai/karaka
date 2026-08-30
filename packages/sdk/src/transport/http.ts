import {
  EVENT_STREAM_MEDIA_TYPE,
  JSON_MEDIA_TYPE,
  KarakaClientError,
  type ChatRequest,
  type ChatResult,
  type ChatStreamEvent,
  type KarakaConnection,
  type KarakaInvocationOptions,
  requireRecord,
  validateChatResult,
  validateErrorBody,
} from './index.ts'

const TENANT_HEADER = 'x-karaka-tenant'

/** HTTP client connection paired with the server-side HTTP Transport plugin. */
export class HttpConnection implements KarakaConnection {
  private readonly endpoint: string

  constructor(endpoint: string | URL) {
    this.endpoint = normalizeEndpoint(endpoint)
  }

  async send(request: Readonly<ChatRequest>, options: Readonly<KarakaInvocationOptions>): Promise<ChatResult> {
    const response = await performFetch(this.url(request), this.init(request, options, JSON_MEDIA_TYPE), options.signal)
    if (!response.ok) throw await readHttpError(response)
    return validateChatResult(await readJson(response))
  }

  async *stream(
    request: Readonly<ChatRequest>,
    options: Readonly<KarakaInvocationOptions>,
  ): AsyncIterable<ChatStreamEvent> {
    const response = await performFetch(this.url(request), this.init(request, options, EVENT_STREAM_MEDIA_TYPE), options.signal)
    if (!response.ok) throw await readHttpError(response)
    if (mediaType(response) !== EVENT_STREAM_MEDIA_TYPE || !response.body) {
      throw new KarakaClientError('INVALID_RESPONSE', `Karaka stream must use ${EVENT_STREAM_MEDIA_TYPE}`, response.status)
    }

    let completed = false
    try {
      for await (const block of readEventBlocks(response.body)) {
        const event = parseEvent(block, response.status)
        if (event.type === 'error') throw new KarakaClientError(event.error.code, event.error.message, response.status)
        if (completed) throw new KarakaClientError('INVALID_RESPONSE', 'Karaka stream emitted data after completion', response.status)
        if (event.type === 'completed') completed = true
        yield event
      }
    } catch (cause) {
      if (cause instanceof KarakaClientError) throw cause
      if (options.signal?.aborted) throw aborted(cause)
      throw new KarakaClientError('TRANSPORT_ERROR', 'Karaka stream failed', undefined, { cause })
    }
    if (!completed) throw new KarakaClientError('INVALID_RESPONSE', 'Karaka stream ended before completion', response.status)
  }

  private url(request: Readonly<ChatRequest>): string {
    if ('agentId' in request) return `${this.endpoint}/chats`
    return `${this.endpoint}/chats/${encodeURIComponent(request.chatId)}/messages`
  }

  private init(
    request: Readonly<ChatRequest>,
    options: Readonly<KarakaInvocationOptions>,
    accept: string,
  ): RequestInit {
    const body = 'agentId' in request
      ? { agentId: request.agentId, message: request.message }
      : { message: request.message }
    const init: RequestInit = {
      method: 'POST',
      headers: {
        accept,
        authorization: `Bearer ${options.credentials.token}`,
        'content-type': JSON_MEDIA_TYPE,
        [TENANT_HEADER]: options.credentials.tenantId,
      },
      body: JSON.stringify(body),
    }
    if (options.signal !== undefined) init.signal = options.signal
    return init
  }
}

async function performFetch(url: string, init: RequestInit, signal: AbortSignal | undefined): Promise<Response> {
  try {
    return await fetch(url, init)
  } catch (cause) {
    if (signal?.aborted) throw aborted(cause)
    throw new KarakaClientError('TRANSPORT_ERROR', 'Karaka request failed', undefined, { cause })
  }
}

async function readHttpError(response: Response): Promise<KarakaClientError> {
  try {
    const envelope = requireRecord(await readJson(response), 'error envelope')
    const error = validateErrorBody(envelope.error)
    return new KarakaClientError(error.code, error.message, response.status)
  } catch (cause) {
    if (cause instanceof KarakaClientError && cause.code !== 'INVALID_RESPONSE') return cause
    return new KarakaClientError('INVALID_RESPONSE', 'Karaka returned an invalid error response', response.status, { cause })
  }
}

async function readJson(response: Response): Promise<unknown> {
  if (mediaType(response) !== JSON_MEDIA_TYPE) {
    throw new KarakaClientError('INVALID_RESPONSE', `Karaka response must use ${JSON_MEDIA_TYPE}`, response.status)
  }
  try {
    return await response.json()
  } catch (cause) {
    throw new KarakaClientError('INVALID_RESPONSE', 'Karaka returned invalid JSON', response.status, { cause })
  }
}

async function* readEventBlocks(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const decoder = new TextDecoder()
  let buffer = ''
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true })
    let separator = findEventSeparator(buffer)
    while (separator) {
      yield buffer.slice(0, separator.index)
      buffer = buffer.slice(separator.index + separator.length)
      separator = findEventSeparator(buffer)
    }
  }
  buffer += decoder.decode()
  if (buffer.trim()) throw new KarakaClientError('INVALID_RESPONSE', 'Karaka stream ended with an incomplete event')
}

function findEventSeparator(value: string): { index: number, length: number } | undefined {
  const match = /\r?\n\r?\n/.exec(value)
  return match ? { index: match.index, length: match[0].length } : undefined
}

function parseEvent(block: string, status: number) {
  let declaredType: string | undefined
  const data: string[] = []
  for (const line of block.split(/\r?\n/)) {
    if (!line || line.startsWith(':')) continue
    if (line.startsWith('event:')) declaredType = line.slice('event:'.length).trim()
    if (line.startsWith('data:')) data.push(line.slice('data:'.length).trimStart())
  }
  if (!data.length) throw new KarakaClientError('INVALID_RESPONSE', 'Karaka stream event has no data', status)

  let value: Record<string, unknown>
  try {
    value = requireRecord(JSON.parse(data.join('\n')) as unknown, 'stream event')
  } catch (cause) {
    if (cause instanceof KarakaClientError) throw cause
    throw new KarakaClientError('INVALID_RESPONSE', 'Karaka stream event contains invalid JSON', status, { cause })
  }
  if (typeof value.type !== 'string' || (declaredType !== undefined && declaredType !== value.type)) {
    throw new KarakaClientError('INVALID_RESPONSE', 'Karaka stream event type is invalid', status)
  }
  if (value.type === 'text-delta') {
    if (typeof value.delta !== 'string') throw new KarakaClientError('INVALID_RESPONSE', 'text delta must be a string', status)
    return Object.freeze({ type: 'text-delta' as const, delta: value.delta })
  }
  if (value.type === 'completed') return Object.freeze({ type: 'completed' as const, result: validateChatResult(value.result) })
  if (value.type === 'error') return Object.freeze({ type: 'error' as const, error: validateErrorBody(value.error) })
  throw new KarakaClientError('INVALID_RESPONSE', `unknown Karaka stream event ${JSON.stringify(value.type)}`, status)
}

function normalizeEndpoint(endpoint: string | URL): string {
  const url = new URL(endpoint)
  if (!['http:', 'https:'].includes(url.protocol)) throw new TypeError('Karaka endpoint must use HTTP or HTTPS')
  if (url.username || url.password) throw new TypeError('Karaka endpoint must not contain credentials')
  if (url.search || url.hash) throw new TypeError('Karaka endpoint must not contain a query or fragment')
  url.pathname = url.pathname.replace(/\/+$/, '')
  return url.toString().replace(/\/$/, '')
}

function mediaType(response: Response): string | undefined {
  return response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
}

function aborted(cause: unknown): KarakaClientError {
  return new KarakaClientError('ABORTED', 'Karaka request was aborted', undefined, { cause })
}
