import { request as requestHttp } from 'node:http'
import { Readable } from 'node:stream'
import { HttpConnection, type HttpDispatcher } from './http.ts'
import type {
  ChatRequest,
  ChatResult,
  ChatStreamEvent,
  KarakaConnection,
  KarakaInvocationOptions,
} from './index.ts'

interface IpcEndpoint {
  readonly socketPath: string
  readonly basePath: string
}

/** Karaka chat protocol over a Unix domain socket. */
export class IpcConnection implements KarakaConnection {
  private readonly connection: HttpConnection

  constructor(endpoint: string | URL, audience?: string) {
    const resolved = resolveEndpoint(endpoint)
    this.connection = new HttpConnection(
      `http://karaka.local${resolved.basePath}`,
      createDispatcher(resolved.socketPath),
      audience ?? `unix://${resolved.socketPath}`,
    )
  }

  send(request: Readonly<ChatRequest>, options: Readonly<KarakaInvocationOptions>): Promise<ChatResult> {
    return this.connection.send(request, options)
  }

  stream(
    request: Readonly<ChatRequest>,
    options: Readonly<KarakaInvocationOptions>,
  ): AsyncIterable<ChatStreamEvent> {
    return this.connection.stream(request, options)
  }
}

function createDispatcher(socketPath: string): HttpDispatcher {
  return request => dispatch(socketPath, request)
}

async function dispatch(
  socketPath: string,
  source: Request,
): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const request = requestHttp({
      socketPath,
      path: new URL(source.url).pathname,
      method: source.method,
      headers: Object.fromEntries(source.headers),
      signal: source.signal,
    }, response => {
      const headers = new Headers()
      for (let index = 0; index < response.rawHeaders.length; index += 2) {
        headers.append(response.rawHeaders[index]!, response.rawHeaders[index + 1]!)
      }
      const body = Readable.toWeb(response) as ReadableStream<Uint8Array>
      resolve(new Response(body, {
        status: response.statusCode ?? 500,
        headers,
      }))
    })
    request.once('error', reject)
    void source.text().then(body => request.end(body), reject)
  })
}

function resolveEndpoint(endpoint: string | URL): IpcEndpoint {
  const url = new URL(endpoint)
  if (url.protocol !== 'unix:') throw new TypeError('Karaka IPC endpoint must use unix')
  if (url.host || url.username || url.password || url.hash) {
    throw new TypeError('Karaka IPC endpoint must contain only an absolute socket path')
  }
  for (const key of url.searchParams.keys()) {
    if (key !== 'basePath') throw new TypeError(`unsupported Karaka IPC endpoint option ${JSON.stringify(key)}`)
  }
  if (url.searchParams.getAll('basePath').length > 1) {
    throw new TypeError('Karaka IPC endpoint must contain at most one basePath option')
  }
  const socketPath = decodeURIComponent(url.pathname)
  if (!socketPath.startsWith('/') || socketPath === '/') {
    throw new TypeError('Karaka IPC endpoint must contain an absolute socket path')
  }
  const basePath = normalizeBasePath(url.searchParams.get('basePath') ?? '/v1')
  return Object.freeze({ socketPath, basePath })
}

function normalizeBasePath(value: string): string {
  const basePath = value.replace(/\/+$/, '')
  if (!basePath.startsWith('/') || basePath.includes('?') || basePath.includes('#')) {
    throw new TypeError('Karaka IPC base path must be an absolute URL path')
  }
  return basePath
}
