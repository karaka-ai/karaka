import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
  ApplicationAcceptedResponseSchema,
  ApplicationAgentSummarySchema,
  ApplicationChatEventSchema,
  ApplicationChatHistorySchema,
  ApplicationChatReceiptSchema,
  ApplicationCreateChatResponseSchema,
  ApplicationIdentitySchema,
  ApplicationModelResponseSchema,
  KARAKA_APPLICATION_API_PATH,
} from './protocol.ts'
import type {
  AgentSummary, ChatContent, ChatEvent, ChatHistory, ChatReceipt, ModelSelection, SecretSource, UserIdentity,
} from './types.ts'

/** Application client configuration. */
export interface KarakaClientConfig {
  readonly endpoint: string
  /** Server transport route prefix; must match its `path` config. */
  readonly path?: string
  readonly chatToken: SecretSource
  readonly fetch?: typeof globalThis.fetch
}

/** Identity-bound chat creation input. */
export interface CreateChatInput {
  readonly agentId: string
  readonly chatId?: string
}

/** Identity-bound message admission input. */
export interface SendChatInput {
  readonly chatId: string
  readonly content: string | readonly ChatContent[]
  readonly requestId?: string
}

/** Identity-bound response to a pending structured interaction. */
export interface RespondInput {
  readonly chatId: string
  readonly interactionId: string
  readonly answers: unknown
}

/** Backend client for one persistent Karaka deployment. */
export class KarakaClient {
  /** Deployment-wide Agent discovery operations. */
  readonly agents: { list: () => Promise<readonly AgentSummary[]> }

  private readonly endpoint: string
  private readonly fetch: typeof globalThis.fetch

  constructor(private readonly config: KarakaClientConfig) {
    this.endpoint = config.endpoint.replace(/\/+$/u, '') + normalizePath(config.path ?? KARAKA_APPLICATION_API_PATH)
    this.fetch = config.fetch ?? globalThis.fetch
    this.agents = {
      list: async () => this.request('/agents', { method: 'GET' }, z.array(ApplicationAgentSummarySchema)),
    }
  }

  /**
   * Bind trusted tenant and user identity without storing it globally.
   * @param identity - application-authenticated tenant and user.
   * @returns identity-bound chat client.
   */
  forUser(identity: UserIdentity): UserKarakaClient {
    ApplicationIdentitySchema.parse(identity)
    return new UserKarakaClient(this, identity)
  }

  /**
   * Dispatch and validate one authenticated JSON request.
   * @param path - endpoint path below the configured origin.
   * @param init - fetch request options.
   * @param schema - response validator.
   * @returns validated response value.
   */
  async request<Value>(path: string, init: RequestInit, schema: z.ZodType<Value>): Promise<Value> {
    const token = await resolveSecret(this.config.chatToken, init.signal ?? undefined)
    const headers = new Headers(init.headers)
    headers.set('authorization', `Bearer ${token}`)
    if (init.body !== undefined && !headers.has('content-type')) headers.set('content-type', 'application/json')
    const response = await this.fetch(`${this.endpoint}${path}`, {
      ...init,
      headers,
    })
    if (!response.ok) throw await responseError(response)
    return schema.parse(await response.json())
  }

  /**
   * Dispatch and validate one authenticated SSE request.
   * @param path - endpoint path below the configured origin.
   * @param body - JSON request body.
   * @param signal - optional caller cancellation.
   * @returns validated chat-event stream.
   */
  async *stream(path: string, body: unknown, signal?: AbortSignal): AsyncIterable<ChatEvent> {
    const token = await resolveSecret(this.config.chatToken, signal)
    const response = await this.fetch(`${this.endpoint}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify(body),
      ...(signal === undefined ? {} : { signal }),
    })
    if (!response.ok) throw await responseError(response)
    if (response.body === null) throw new Error('Karaka stream response has no body')
    yield* parseEventStream(response.body)
  }
}

/** Chat API bound to one trusted application user. */
export class UserKarakaClient {
  /** Chat operations bound to the constructor's trusted identity. */
  readonly chats: {
    create: (input: CreateChatInput) => Promise<{ readonly chatId: string; readonly agentId: string }>
    send: (input: SendChatInput) => Promise<ChatReceipt>
    stream: (input: { readonly chatId: string; readonly cursor?: number; readonly signal?: AbortSignal }) => AsyncIterable<ChatEvent>
    history: (chatId: string) => Promise<ChatHistory>
    cancel: (chatId: string) => Promise<{ readonly accepted: true }>
    setModel: (chatId: string, model: ModelSelection) => Promise<{ readonly selected: ModelSelection }>
    respond: (input: RespondInput) => Promise<{ readonly accepted: true }>
  }

  constructor(client: KarakaClient, identity: UserIdentity) {
    this.chats = {
      create: async input => client.request('/chats', {
        method: 'POST',
        body: JSON.stringify({ ...identity, agentId: input.agentId, chatId: input.chatId ?? randomUUID() }),
      }, ApplicationCreateChatResponseSchema),
      send: async (input) => {
        const requestId = input.requestId ?? randomUUID()
        const content = typeof input.content === 'string'
          ? [{ type: 'text' as const, text: input.content }]
          : input.content
        return client.request(`/chats/${encodeURIComponent(input.chatId)}/messages`, {
          method: 'POST',
          body: JSON.stringify({ ...identity, requestId, content }),
        }, ApplicationChatReceiptSchema)
      },
      stream: input => client.stream(
        `/chats/${encodeURIComponent(input.chatId)}/stream`,
        { ...identity, cursor: input.cursor },
        input.signal,
      ),
      history: chatId => client.request(`/chats/${encodeURIComponent(chatId)}/history`, {
        method: 'POST', body: JSON.stringify(identity),
      }, ApplicationChatHistorySchema),
      cancel: chatId => client.request(`/chats/${encodeURIComponent(chatId)}/cancel`, {
        method: 'POST', body: JSON.stringify(identity),
      }, ApplicationAcceptedResponseSchema),
      setModel: (chatId, model) => client.request(`/chats/${encodeURIComponent(chatId)}/model`, {
        method: 'POST', body: JSON.stringify({ ...identity, ...model }),
      }, ApplicationModelResponseSchema),
      respond: input => client.request(`/chats/${encodeURIComponent(input.chatId)}/responses`, {
        method: 'POST', body: JSON.stringify({ ...identity, interactionId: input.interactionId, answers: input.answers }),
      }, ApplicationAcceptedResponseSchema),
    }
  }
}

/**
 * Create a backend client without starting a process or opening a port.
 * @param config - endpoint, credential resolver, and optional fetch implementation.
 * @returns unbound deployment client.
 */
export function createKarakaClient(config: KarakaClientConfig): KarakaClient {
  return new KarakaClient(config)
}

function normalizePath(path: string): string {
  if (!path.startsWith('/') || path === '/' || path.endsWith('/')) {
    throw new Error('Karaka client path must start with / and have no trailing slash')
  }
  return path
}

async function resolveSecret(source: SecretSource, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted()
  const operation = Promise.resolve(typeof source === 'function' ? source(signal) : source)
  const value = signal === undefined
    ? await operation
    : await new Promise<string>((resolve, reject) => {
      const abort = (): void => {
        reject(signal.reason instanceof Error ? signal.reason : new Error('Karaka request cancelled'))
      }
      signal.addEventListener('abort', abort, { once: true })
      void operation.then(resolve, reject).finally(() => { signal.removeEventListener('abort', abort) })
    })
  if (value.length === 0) throw new Error('Karaka credential must not be empty')
  return value
}

async function responseError(response: Response): Promise<Error> {
  let detail: { code?: unknown; message?: unknown } = {}
  try { detail = await response.json() as typeof detail } catch { /* non-JSON proxy response */ }
  const error = new Error(typeof detail.message === 'string' ? detail.message : `Karaka request failed with HTTP ${response.status}`)
  if (typeof detail.code === 'string') Object.assign(error, { code: detail.code })
  return error
}

function readEventStreamLine(
  buffer: string,
  endOfStream: boolean,
): { readonly line: string; readonly consumed: number } | undefined {
  for (let index = 0; index < buffer.length; index++) {
    const character = buffer[index]
    if (character === '\n') return { line: buffer.slice(0, index), consumed: index + 1 }
    if (character !== '\r') continue
    if (index + 1 === buffer.length && !endOfStream) return undefined
    return {
      line: buffer.slice(0, index),
      consumed: index + (buffer[index + 1] === '\n' ? 2 : 1),
    }
  }
  return endOfStream && buffer.length > 0
    ? { line: buffer, consumed: buffer.length }
    : undefined
}

async function* parseEventStream(stream: ReadableStream<Uint8Array>): AsyncIterable<ChatEvent> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let frame: string[] = []
  let completed = false
  try {
    while (true) {
      const next = await reader.read()
      buffer += decoder.decode(next.done ? undefined : next.value, { stream: !next.done })
      let parsed = readEventStreamLine(buffer, next.done)
      while (parsed !== undefined) {
        buffer = buffer.slice(parsed.consumed)
        if (parsed.line.length > 0) {
          frame.push(parsed.line)
          parsed = readEventStreamLine(buffer, next.done)
          continue
        }
        const data = frame.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
        frame = []
        parsed = readEventStreamLine(buffer, next.done)
        if (data.length === 0) continue
        const event = ApplicationChatEventSchema.parse(JSON.parse(data))
        if (event.type === 'error') {
          const error = new Error(event.message)
          Object.assign(error, { code: event.code })
          throw error
        }
        yield event
      }
      if (next.done) {
        completed = true
        break
      }
    }
  } finally {
    if (!completed) {
      try { await reader.cancel() } catch { /* cancellation already reached the transport */ }
    }
    reader.releaseLock()
  }
}
