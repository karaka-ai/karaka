/** Stable media types shared by the SDK and server Transport plugins. */
export const JSON_MEDIA_TYPE = 'application/json'
export const EVENT_STREAM_MEDIA_TYPE = 'text/event-stream'

export interface KarakaCredentials {
  readonly tenantId: string
  readonly token: string
}

export type KarakaCredentialSource = Readonly<KarakaCredentials> | (() => Readonly<KarakaCredentials> | Promise<Readonly<KarakaCredentials>>)

export type ChatRequest =
  | { readonly agentId: string, readonly message: string, readonly chatId?: never }
  | { readonly chatId: string, readonly message: string, readonly agentId?: never }

export interface ChatMessage {
  readonly role: 'assistant'
  readonly content: string
}

export interface ChatResult {
  readonly chatId: string
  readonly agentId: string
  readonly model: string
  readonly message: ChatMessage
}

export interface ChatTextDeltaEvent {
  readonly type: 'text-delta'
  readonly delta: string
}

export interface ChatCompletedEvent {
  readonly type: 'completed'
  readonly result: ChatResult
}

export interface ChatErrorBody {
  readonly code: string
  readonly message: string
}

export interface ChatErrorEnvelope {
  readonly error: ChatErrorBody
}

export interface ChatErrorEvent {
  readonly type: 'error'
  readonly error: ChatErrorBody
}

export type ChatStreamEvent = ChatTextDeltaEvent | ChatCompletedEvent
export type TransportStreamEvent = ChatStreamEvent | ChatErrorEvent

export interface KarakaInvocationOptions {
  readonly credentials: Readonly<KarakaCredentials>
  readonly signal?: AbortSignal
}

/** Advanced client connection contract implemented by HTTP and future local providers. */
export interface KarakaConnection {
  send(request: Readonly<ChatRequest>, options: Readonly<KarakaInvocationOptions>): Promise<ChatResult>
  stream(request: Readonly<ChatRequest>, options: Readonly<KarakaInvocationOptions>): AsyncIterable<ChatStreamEvent>
}

export class KarakaClientError extends Error {
  override readonly name = 'KarakaClientError'

  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
    options?: ErrorOptions,
  ) {
    super(message, options)
  }
}

export function normalizeChatRequest(request: Readonly<ChatRequest>): ChatRequest {
  if (!request || typeof request !== 'object') throw new TypeError('chat request must be an object')
  const message = requireText(request?.message, 'message')
  if ('agentId' in request && request.agentId !== undefined && request.chatId === undefined) {
    return Object.freeze({ agentId: requireText(request.agentId, 'agent ID'), message })
  }
  if ('chatId' in request && request.chatId !== undefined && request.agentId === undefined) {
    return Object.freeze({ chatId: requireText(request.chatId, 'chat ID'), message })
  }
  throw new TypeError('chat request must contain exactly one of agentId or chatId')
}

export async function resolveCredentials(source: KarakaCredentialSource | undefined): Promise<Readonly<KarakaCredentials>> {
  if (source === undefined) throw new TypeError('Karaka credentials are required')
  const credentials = typeof source === 'function' ? await source() : source
  const tenantId = requireText(credentials?.tenantId, 'tenant ID')
  const token = requireText(credentials?.token, 'access token')
  if (/\s/.test(token)) throw new TypeError('access token must not contain whitespace')
  return Object.freeze({ tenantId, token })
}

export function validateChatResult(value: unknown): ChatResult {
  const record = requireRecord(value, 'chat result')
  const message = requireRecord(record.message, 'chat message')
  if (message.role !== 'assistant') throw invalidResponse('chat message role must be assistant')
  return Object.freeze({
    chatId: requireResponseText(record.chatId, 'chat ID'),
    agentId: requireResponseText(record.agentId, 'agent ID'),
    model: requireResponseText(record.model, 'model ID'),
    message: Object.freeze({
      role: 'assistant',
      content: requireResponseString(message.content, 'chat message content'),
    }),
  })
}

export function validateErrorBody(value: unknown): ChatErrorBody {
  const record = requireRecord(value, 'error')
  return Object.freeze({
    code: requireResponseText(record.code, 'error code'),
    message: requireResponseText(record.message, 'error message'),
  })
}

export function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidResponse(`${label} must be an object`)
  return value as Record<string, unknown>
}

function requireResponseText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw invalidResponse(`${label} must be a non-empty string`)
  return value
}

function requireResponseString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw invalidResponse(`${label} must be a string`)
  return value
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} must be a non-empty string`)
  return value
}

function invalidResponse(message: string): KarakaClientError {
  return new KarakaClientError('INVALID_RESPONSE', message)
}
