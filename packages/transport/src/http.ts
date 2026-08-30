import {
  AgentRuntimeError,
  type AgentChatResumeRequest,
  type AgentChatRunResult,
  type AgentChatStartRequest,
  type AgentRuntimeErrorCode,
} from '@karaka/agent-runtime'
import {
  AuthenticationError,
  type AuthenticatedIdentity,
} from '@karaka/authentication'
import type { Context } from '@karaka/cordis'
import Schema from '@karaka/schemastery'
import {
  EVENT_STREAM_MEDIA_TYPE,
  JSON_MEDIA_TYPE,
  type ChatErrorEvent,
  type ChatResult,
  type TransportStreamEvent,
} from '@karaka/sdk'
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server,
  type ServerResponse,
} from 'node:http'

const TENANT_HEADER = 'x-karaka-tenant'
const agentErrorStatuses: Partial<Record<AgentRuntimeErrorCode, number>> = {
  ABORTED: 499,
  CHAT_NOT_FOUND: 404,
  INVALID_REQUEST: 400,
  SESSION_CONFLICT: 409,
  UNKNOWN_AGENT: 404,
  UNKNOWN_MODEL: 503,
}

/** YAML-serializable HTTP server configuration. */
export interface Config {
  host?: string
  port?: number
  basePath?: string
  corsOrigins?: string[]
  maxBodyBytes?: number
  requestTimeoutMs?: number
}

/** Shared configuration for the Karaka chat protocol over a Node server. */
export interface NodeTransportConfig {
  basePath?: string
  corsOrigins?: string[]
  maxBodyBytes?: number
  requestTimeoutMs?: number
}

export const Config: Schema<Config> = Schema.object({
  host: Schema.string().default('127.0.0.1'),
  port: Schema.natural().max(65_535).default(3_000),
  basePath: Schema.string().default('/v1'),
  corsOrigins: Schema.array(Schema.string()).default([]),
  maxBodyBytes: Schema.natural().min(1).default(65_536),
  requestTimeoutMs: Schema.natural().min(1).default(120_000),
})

interface ResolvedNodeTransportConfig {
  readonly basePath: string
  readonly corsOrigins: ReadonlySet<string>
  readonly maxBodyBytes: number
  readonly requestTimeoutMs: number
}

/** Open one authenticated HTTP application boundary as an owned Cordis plugin. */
export const plugin = {
  name: 'transport-http',
  inject: ['agentRuntime', 'authentication'],
  Config,
  async apply(ctx: Context, config: Config) {
    const host = requireText(config.host ?? '127.0.0.1', 'transport host')
    const port = requireInteger(config.port ?? 3_000, 'transport port', 0, 65_535)
    return openNodeTransport(ctx, config, server => server.listen(port, host))
  },
}

class HttpTransport {
  private readonly activeInvocations = new Set<AbortController>()
  private readonly server: Server

  constructor(
    private readonly ctx: Context,
    private readonly config: ResolvedNodeTransportConfig,
    private readonly listen: (server: Server) => void,
  ) {
    this.server = createServer((request, response) => {
      void this.handle(request, response)
    })
  }

  async open(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        this.server.off('listening', onListening)
        reject(error)
      }
      const onListening = () => {
        this.server.off('error', onError)
        resolve()
      }
      this.server.once('error', onError)
      this.server.once('listening', onListening)
      this.listen(this.server)
    })
  }

  async close(): Promise<void> {
    for (const controller of this.activeInvocations) controller.abort(new Error('transport disposed'))
    await new Promise<void>((resolve, reject) => {
      this.server.close(error => error ? reject(error) : resolve())
      this.server.closeAllConnections()
    })
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    let cors: OutgoingHttpHeaders = {}
    try {
      cors = this.resolveCors(request.headers)
      if (request.method === 'OPTIONS') {
        response.writeHead(204, {
          ...cors,
          'access-control-allow-headers': `authorization, content-type, ${TENANT_HEADER}`,
          'access-control-allow-methods': 'POST, OPTIONS',
          'access-control-max-age': '600',
        })
        response.end()
        return
      }

      const runtimeRequest = await this.readRuntimeRequest(request)
      const principal = await this.authenticate(request.headers)
      if (acceptsEventStream(request.headers.accept)) {
        await this.stream(response, cors, principal, runtimeRequest)
      } else {
        await this.send(response, cors, principal, runtimeRequest)
      }
    } catch (error) {
      this.writeJsonError(response, error, cors)
    }
  }

  private async send(
    response: ServerResponse,
    headers: OutgoingHttpHeaders,
    principal: AuthenticatedIdentity,
    request: Readonly<AgentChatStartRequest | AgentChatResumeRequest>,
  ): Promise<void> {
    const invocation = this.trackInvocation(response)
    try {
      const result = await this.ctx.authentication.withPrincipal(principal, () => {
        return this.ctx.agentRuntime.run(request, { signal: invocation.controller.signal })
      })
      if (!response.destroyed) writeJson(response, 200, toChatResult(result), headers)
    } finally {
      invocation.dispose()
    }
  }

  private async stream(
    response: ServerResponse,
    headers: OutgoingHttpHeaders,
    principal: AuthenticatedIdentity,
    request: Readonly<AgentChatStartRequest | AgentChatResumeRequest>,
  ): Promise<void> {
    const invocation = this.trackInvocation(response)
    const { controller } = invocation
    response.writeHead(200, {
      ...headers,
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'content-type': `${EVENT_STREAM_MEDIA_TYPE}; charset=utf-8`,
      'x-accel-buffering': 'no',
    })
    response.flushHeaders()

    try {
      const result = await this.ctx.authentication.withPrincipal(principal, () => {
        return this.ctx.agentRuntime.stream(
          request,
          event => writeEvent(response, event, controller.signal),
          { signal: controller.signal },
        )
      })
      await writeEvent(response, Object.freeze({ type: 'completed', result: toChatResult(result) }), controller.signal)
    } catch (error) {
      if (!controller.signal.aborted && !response.destroyed) {
        await writeEvent(response, toTransportError(error), controller.signal)
      }
    } finally {
      invocation.dispose()
      if (!response.destroyed) response.end()
    }
  }

  private trackInvocation(response: ServerResponse) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(new Error('transport deadline exceeded')), this.config.requestTimeoutMs)
    const abortClosedResponse = () => {
      if (!response.writableEnded) controller.abort(new Error('transport connection closed'))
    }
    response.once('close', abortClosedResponse)
    this.activeInvocations.add(controller)
    if (response.destroyed) abortClosedResponse()

    return {
      controller,
      dispose: () => {
        clearTimeout(timeout)
        response.off('close', abortClosedResponse)
        this.activeInvocations.delete(controller)
      },
    }
  }

  private async authenticate(headers: IncomingHttpHeaders): Promise<AuthenticatedIdentity> {
    const tenantId = requireHeader(headers[TENANT_HEADER], TENANT_HEADER)
    const authorization = requireHeader(headers.authorization, 'authorization')
    const match = /^Bearer\s+(\S+)$/i.exec(authorization)
    if (!match) throw new AuthenticationError('INVALID_REQUEST', 'authentication failed')
    return this.ctx.authentication.authenticate({ tenantId, token: match[1]! })
  }

  private async readRuntimeRequest(
    request: IncomingMessage,
  ): Promise<Readonly<AgentChatStartRequest | AgentChatResumeRequest>> {
    if (request.method !== 'POST') throw new HttpTransportError(405, 'METHOD_NOT_ALLOWED', 'method not allowed')
    const url = new URL(request.url ?? '/', 'http://karaka.local')
    if (url.search) throw new HttpTransportError(400, 'INVALID_REQUEST', 'query parameters are not supported')
    const body = await readJson(request, this.config.maxBodyBytes)
    if (url.pathname === `${this.config.basePath}/chats`) {
      requireKeys(body, ['agentId', 'message'])
      return Object.freeze({
        agentId: requireBodyText(body.agentId, 'agentId'),
        message: requireBodyText(body.message, 'message'),
        persist: true,
      })
    }

    const prefix = `${this.config.basePath}/chats/`
    const suffix = '/messages'
    if (url.pathname.startsWith(prefix) && url.pathname.endsWith(suffix)) {
      requireKeys(body, ['message'])
      const encoded = url.pathname.slice(prefix.length, -suffix.length)
      let chatId: string
      try {
        chatId = decodeURIComponent(encoded)
      } catch (cause) {
        throw new HttpTransportError(400, 'INVALID_REQUEST', 'chat ID is invalid', { cause })
      }
      if (!chatId) throw new HttpTransportError(400, 'INVALID_REQUEST', 'chat ID is invalid')
      return Object.freeze({ chatId, message: requireBodyText(body.message, 'message') })
    }
    throw new HttpTransportError(404, 'NOT_FOUND', 'route not found')
  }

  private resolveCors(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
    const origin = headers.origin
    if (!origin) return {}
    if (typeof origin !== 'string' || !this.config.corsOrigins.has(origin)) {
      throw new HttpTransportError(403, 'ORIGIN_NOT_ALLOWED', 'origin not allowed')
    }
    return {
      'access-control-allow-origin': origin,
      vary: 'Origin',
    }
  }

  private writeJsonError(response: ServerResponse, error: unknown, headers: OutgoingHttpHeaders) {
    if (response.headersSent || response.destroyed) {
      if (!response.destroyed) response.end()
      return
    }
    const failure = toPublicError(error)
    writeJson(response, failure.status, { error: failure.error }, headers)
  }
}

class HttpTransportError extends Error {
  override readonly name = 'HttpTransportError'

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
  }
}

function resolveConfig(config: NodeTransportConfig): ResolvedNodeTransportConfig {
  const maxBodyBytes = requireInteger(config.maxBodyBytes ?? 65_536, 'maximum body bytes', 1)
  const requestTimeoutMs = requireInteger(config.requestTimeoutMs ?? 120_000, 'request timeout', 1)
  const basePath = requireText(config.basePath ?? '/v1', 'transport base path').replace(/\/$/, '')
  if (!basePath.startsWith('/') || basePath.includes('?') || basePath.includes('#')) {
    throw new TypeError('transport base path must be an absolute URL path')
  }
  const corsOrigins = new Set((config.corsOrigins ?? []).map(origin => requireOrigin(origin)))
  return Object.freeze({ basePath, corsOrigins, maxBodyBytes, requestTimeoutMs })
}

/** @internal Open the shared chat protocol on a caller-selected Node listener. */
export async function openNodeTransport(
  ctx: Context,
  config: NodeTransportConfig,
  listen: (server: Server) => void,
): Promise<() => Promise<void>> {
  const transport = new HttpTransport(ctx, resolveConfig(config), listen)
  await transport.open()
  return () => transport.close()
}

async function readJson(request: IncomingMessage, maxBodyBytes: number): Promise<Record<string, unknown>> {
  const mediaType = request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase()
  if (mediaType !== JSON_MEDIA_TYPE) {
    throw new HttpTransportError(415, 'UNSUPPORTED_MEDIA_TYPE', `content-type must be ${JSON_MEDIA_TYPE}`)
  }
  const chunks: Buffer[] = []
  let length = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    length += buffer.length
    if (length > maxBodyBytes) {
      request.resume()
      throw new HttpTransportError(413, 'PAYLOAD_TOO_LARGE', 'request body is too large')
    }
    chunks.push(buffer)
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('body is not an object')
    return value as Record<string, unknown>
  } catch (cause) {
    throw new HttpTransportError(400, 'INVALID_JSON', 'request body must be a JSON object', { cause })
  }
}

async function writeEvent(
  response: ServerResponse,
  event: Readonly<TransportStreamEvent>,
  signal: AbortSignal,
): Promise<void> {
  if (response.destroyed) throw new Error('transport connection closed')
  const data = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
  if (!response.write(data)) await waitForDrain(response, signal)
}

async function waitForDrain(response: ServerResponse, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      response.off('drain', onDrain)
      response.off('close', onClose)
      response.off('error', onError)
      signal.removeEventListener('abort', onAbort)
    }
    const finish = (operation: () => void) => {
      cleanup()
      operation()
    }
    const onDrain = () => finish(resolve)
    const onClose = () => finish(() => reject(new Error('transport connection closed')))
    const onError = (error: Error) => finish(() => reject(error))
    const onAbort = () => finish(() => reject(signal.reason ?? new Error('transport invocation aborted')))

    response.once('drain', onDrain)
    response.once('close', onClose)
    response.once('error', onError)
    signal.addEventListener('abort', onAbort, { once: true })
    if (response.destroyed) onClose()
    else if (signal.aborted) onAbort()
  })
}

function writeJson(
  response: ServerResponse,
  status: number,
  value: unknown,
  headers: OutgoingHttpHeaders = {},
) {
  response.writeHead(status, { ...headers, 'content-type': `${JSON_MEDIA_TYPE}; charset=utf-8` })
  response.end(JSON.stringify(value))
}

function acceptsEventStream(accept: string | undefined) {
  return accept?.split(',').some(value => value.split(';', 1)[0]?.trim() === EVENT_STREAM_MEDIA_TYPE) ?? false
}

function requireKeys(body: Record<string, unknown>, expected: readonly string[]) {
  const actual = Object.keys(body)
  if (actual.length !== expected.length || actual.some(key => !expected.includes(key))) {
    throw new HttpTransportError(400, 'INVALID_REQUEST', `request accepts only ${expected.join(', ')}`)
  }
}

function requireBodyText(value: unknown, name: string): string {
  try {
    return requireText(value, name)
  } catch (cause) {
    throw new HttpTransportError(400, 'INVALID_REQUEST', `${name} must be a non-empty string`, { cause })
  }
}

function requireHeader(value: string | string[] | undefined, name: string): string {
  if (typeof value === 'string' && value.trim()) return value
  throw new AuthenticationError('INVALID_REQUEST', 'authentication failed', {
    cause: new TypeError(`${name} header is required`),
  })
}

function requireOrigin(value: string): string {
  const origin = requireText(value, 'CORS origin')
  const url = new URL(origin)
  if (url.origin !== origin || !['http:', 'https:'].includes(url.protocol)) {
    throw new TypeError(`invalid CORS origin "${origin}"`)
  }
  return origin
}

function requireInteger(value: number, label: string, minimum: number, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} must be an integer from ${minimum} to ${maximum}`)
  }
  return value
}

function requireText(value: unknown, label: string): string {
  if (typeof value === 'string' && value.trim()) return value
  throw new TypeError(`${label} must be a non-empty string`)
}

function toTransportError(error: unknown): ChatErrorEvent {
  return Object.freeze({ type: 'error', error: toPublicError(error).error })
}

function toPublicError(error: unknown): {
  readonly status: number
  readonly error: { readonly code: string, readonly message: string }
} {
  if (error instanceof HttpTransportError) return publicFailure(error.status, error.code, error.message)
  if (error instanceof AuthenticationError) return publicFailure(401, error.code, 'authentication failed')
  if (error instanceof AgentRuntimeError) {
    const status = agentErrorStatuses[error.code] ?? 500
    return publicFailure(status, error.code, error.message)
  }
  if (hasErrorCode(error, 'EXHAUSTED')) return publicFailure(402, 'EXHAUSTED', 'entitlement exhausted')
  if (hasErrorCode(error, 'UNAVAILABLE')) return publicFailure(503, 'UNAVAILABLE', 'service unavailable')
  return publicFailure(500, 'INTERNAL_ERROR', 'internal error')
}

function publicFailure(status: number, code: string, message: string) {
  return Object.freeze({ status, error: Object.freeze({ code, message }) })
}

function toChatResult(result: Readonly<AgentChatRunResult>): ChatResult {
  if (result.message.role !== 'assistant') throw new AgentRuntimeError('INVALID_MODEL_RESPONSE', 'agent returned a non-assistant message')
  return Object.freeze({
    chatId: result.chatId,
    agentId: result.agentId,
    model: result.model,
    message: Object.freeze({ role: 'assistant', content: result.message.content }),
  })
}

function hasErrorCode(error: unknown, code: string): error is Error & { code: string } {
  return error instanceof Error && 'code' in error && error.code === code
}

export default plugin
