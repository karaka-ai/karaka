import { HttpConnection } from './transport/http.ts'
import {
  type ChatRequest,
  type ChatResult,
  type ChatStreamEvent,
  type KarakaConnection,
  type KarakaCredentials,
  type KarakaCredentialSource,
  normalizeChatRequest,
  resolveCredentials,
} from './transport/index.ts'

export interface ChatCallOptions {
  /** Overrides the client credential source for this invocation. */
  readonly credentials?: KarakaCredentialSource
  readonly signal?: AbortSignal
}

export interface KarakaChatClient {
  send(request: Readonly<ChatRequest>, options?: Readonly<ChatCallOptions>): Promise<ChatResult>
  stream(request: Readonly<ChatRequest>, options?: Readonly<ChatCallOptions>): AsyncIterable<ChatStreamEvent>
}

export interface KarakaClient {
  readonly chat: KarakaChatClient
}

interface SharedClientOptions {
  /** Static credentials or a resolver called separately for every invocation. */
  readonly credentials?: KarakaCredentialSource
}

export type KarakaClientOptions = SharedClientOptions & (
  | { readonly endpoint: string | URL, readonly connection?: never }
  | { readonly connection: KarakaConnection, readonly endpoint?: never }
)

/** Create one application-facing client without exposing Cordis or Agent Runtime. */
export function createKarakaClient(options: Readonly<KarakaClientOptions>): KarakaClient {
  const connection = resolveConnection(options)
  const chat: KarakaChatClient = Object.freeze({
    send(request: Readonly<ChatRequest>, callOptions?: Readonly<ChatCallOptions>) {
      return invoke(connection, options.credentials, request, callOptions)
    },
    async *stream(request: Readonly<ChatRequest>, callOptions?: Readonly<ChatCallOptions>) {
      const invocation = await prepareInvocation(options.credentials, request, callOptions)
      yield* connection.stream(invocation.request, invocation.options)
    },
  })
  return Object.freeze({ chat })
}

async function invoke(
  connection: KarakaConnection,
  defaultCredentials: KarakaCredentialSource | undefined,
  request: Readonly<ChatRequest>,
  options: Readonly<ChatCallOptions> | undefined,
): Promise<ChatResult> {
  const invocation = await prepareInvocation(defaultCredentials, request, options)
  return connection.send(invocation.request, invocation.options)
}

async function prepareInvocation(
  defaultCredentials: KarakaCredentialSource | undefined,
  request: Readonly<ChatRequest>,
  options: Readonly<ChatCallOptions> | undefined,
): Promise<{
  readonly request: ChatRequest
  readonly options: { readonly credentials: Readonly<KarakaCredentials>, readonly signal?: AbortSignal }
}> {
  const normalized = normalizeChatRequest(request)
  const credentials = await resolveCredentials(options?.credentials ?? defaultCredentials)
  const invocationOptions = options?.signal === undefined
    ? Object.freeze({ credentials })
    : Object.freeze({ credentials, signal: options.signal })
  return Object.freeze({ request: normalized, options: invocationOptions })
}

function resolveConnection(options: Readonly<KarakaClientOptions>): KarakaConnection {
  if ('endpoint' in options && options.endpoint !== undefined && options.connection === undefined) {
    return new HttpConnection(options.endpoint)
  }
  if ('connection' in options && options.connection !== undefined && options.endpoint === undefined) {
    const connection = options.connection
    if (typeof connection.send === 'function' && typeof connection.stream === 'function') return connection
  }
  throw new TypeError('Karaka client requires exactly one of endpoint or connection')
}
