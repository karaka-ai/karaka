import { HttpConnection } from './transport/http.ts'
import { IpcConnection } from './transport/ipc.ts'
import {
  type ChatRequest,
  type ChatResult,
  type ChatStreamEvent,
  type KarakaConnection,
  type KarakaServerAuthentication,
  type KarakaUserContext,
  type KarakaUserSource,
  normalizeChatRequest,
  resolveUser,
} from './transport/index.ts'

export interface ChatCallOptions {
  /** Overrides the trusted user context for this invocation. */
  readonly user?: KarakaUserSource
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
  /** Server-authentication client supplied by the selected provider package. */
  readonly authentication: KarakaServerAuthentication
  /** Static user context or a resolver called separately for every invocation. */
  readonly user: KarakaUserSource
}

export type KarakaClientOptions = SharedClientOptions & (
  | { readonly endpoint: string | URL, readonly audience?: string, readonly connection?: never }
  | { readonly connection: KarakaConnection, readonly endpoint?: never }
)

/** Create one application-facing client without exposing Cordis or Agent Runtime. */
export function createKarakaClient(options: Readonly<KarakaClientOptions>): KarakaClient {
  const connection = resolveConnection(options)
  const chat: KarakaChatClient = Object.freeze({
    send(request: Readonly<ChatRequest>, callOptions?: Readonly<ChatCallOptions>) {
      return invoke(connection, options.authentication, options.user, request, callOptions)
    },
    async *stream(request: Readonly<ChatRequest>, callOptions?: Readonly<ChatCallOptions>) {
      const invocation = await prepareInvocation(options.authentication, options.user, request, callOptions)
      yield* connection.stream(invocation.request, invocation.options)
    },
  })
  return Object.freeze({ chat })
}

async function invoke(
  connection: KarakaConnection,
  authentication: KarakaServerAuthentication,
  defaultUser: KarakaUserSource,
  request: Readonly<ChatRequest>,
  options: Readonly<ChatCallOptions> | undefined,
): Promise<ChatResult> {
  const invocation = await prepareInvocation(authentication, defaultUser, request, options)
  return connection.send(invocation.request, invocation.options)
}

async function prepareInvocation(
  authentication: KarakaServerAuthentication,
  defaultUser: KarakaUserSource,
  request: Readonly<ChatRequest>,
  options: Readonly<ChatCallOptions> | undefined,
): Promise<{
  readonly request: ChatRequest
  readonly options: {
    readonly authentication: KarakaServerAuthentication
    readonly user: Readonly<KarakaUserContext>
    readonly signal?: AbortSignal
  }
}> {
  if (!authentication || typeof authentication.request !== 'function') {
    throw new TypeError('Karaka server authentication is required')
  }
  const normalized = normalizeChatRequest(request)
  const user = await resolveUser(options?.user ?? defaultUser)
  const invocationOptions = options?.signal === undefined
    ? Object.freeze({ authentication, user })
    : Object.freeze({ authentication, user, signal: options.signal })
  return Object.freeze({ request: normalized, options: invocationOptions })
}

function resolveConnection(options: Readonly<KarakaClientOptions>): KarakaConnection {
  if ('endpoint' in options && options.endpoint !== undefined && options.connection === undefined) {
    const endpoint = new URL(options.endpoint)
    if (endpoint.protocol === 'unix:') return new IpcConnection(endpoint, options.audience)
    return new HttpConnection(endpoint, undefined, options.audience)
  }
  if ('connection' in options && options.connection !== undefined && options.endpoint === undefined) {
    const connection = options.connection
    if (typeof connection.send === 'function' && typeof connection.stream === 'function') return connection
  }
  throw new TypeError('Karaka client requires exactly one of endpoint or connection')
}
