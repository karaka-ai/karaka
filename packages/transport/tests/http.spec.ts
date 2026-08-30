import AgentRuntime from '@karaka/agent-runtime'
import EchoModel from '@karaka/agent-runtime/model-echo'
import SessionStorage from '@karaka/agent-runtime/session-storage'
import Authentication, { type AuthenticationProvider } from '@karaka/authentication'
import { OAuthClientCredentialsProvider } from '@karaka/authentication/oauth-client-credentials'
import { Context, type Context as CordisContext } from '@karaka/cordis'
import Entitlement from '@karaka/entitlement'
import { createKarakaClient, EVENT_STREAM_MEDIA_TYPE } from '@karaka/sdk'
import Storage from '@karaka/storage'
import StorageLocal from '@karaka/storage/local'
import HttpTransport from '@karaka/transport/http'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('HTTP Transport', () => {
  it('authenticates JSON chat turns and preserves durable ownership', async () => {
    const runtime = await createRuntime()
    const userA = createKarakaClient({
      endpoint: `${runtime.endpoint}/v1`,
      authentication,
      user: { tenantId: 'acme', userId: 'user-a' },
    })
    const userB = createKarakaClient({
      endpoint: `${runtime.endpoint}/v1`,
      authentication,
      user: { tenantId: 'acme', userId: 'user-b' },
    })

    try {
      const first = await userA.chat.send({
        agentId: 'support',
        message: 'Hello',
      })
      expect(first).toMatchObject({
        agentId: 'support',
        model: 'support-model',
        message: { role: 'assistant', content: 'Received: Hello' },
      })
      const chatId = first.chatId

      const resumed = await userA.chat.send({
        chatId,
        message: 'Again',
      })
      expect(resumed).toMatchObject({ chatId, message: { content: 'Received: Again' } })

      await expect(userB.chat.send({
        chatId,
        message: 'Steal it',
      })).rejects.toMatchObject({
        name: 'KarakaClientError',
        code: 'CHAT_NOT_FOUND',
        message: 'chat is not available',
        status: 404,
      })

      await expect(userA.chat.send({
        chatId: 'opaque/chat',
        message: 'Missing',
      })).rejects.toMatchObject({ code: 'CHAT_NOT_FOUND', status: 404 })
    } finally {
      await runtime.close()
    }
  })

  it('negotiates SSE and streams incremental text through the SDK', async () => {
    const runtime = await createRuntime()
    const client = createKarakaClient({
      endpoint: `${runtime.endpoint}/v1`,
      authentication,
      user: { tenantId: 'acme', userId: 'sdk-user' },
    })

    try {
      const sdkEvents = []
      for await (const event of client.chat.stream({ agentId: 'support', message: 'SDK' })) sdkEvents.push(event)
      expect(sdkEvents).toEqual([
        { type: 'text-delta', delta: 'Received: ' },
        { type: 'text-delta', delta: 'SDK' },
        {
          type: 'completed',
          result: {
            chatId: expect.any(String),
            agentId: 'support',
            model: 'support-model',
            message: { role: 'assistant', content: 'Received: SDK' },
          },
        },
      ])
    } finally {
      await runtime.close()
    }
  })

  it('rejects missing server credentials', async () => {
    const runtime = await createRuntime()

    try {
      const unauthenticated = await fetch(`${runtime.endpoint}/v1/chats`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          agentId: 'support',
          message: 'Hello',
          user: { tenantId: 'acme', userId: 'user-a' },
        }),
      })
      expect(unauthenticated.status).toBe(401)
      expect(unauthenticated.headers.get('www-authenticate')).toBe('Bearer')
      await expect(unauthenticated.json()).resolves.toEqual({
        error: { code: 'INVALID_CREDENTIAL', message: 'authentication failed' },
      })

      const invalidUnauthenticated = await fetch(`${runtime.endpoint}/v1/chats`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{not-json',
      })
      expect(invalidUnauthenticated.status).toBe(401)
      expect(invalidUnauthenticated.headers.get('www-authenticate')).toBe('Bearer')

      const preflight = await fetch(`${runtime.endpoint}/v1/chats`, {
        method: 'OPTIONS',
        headers: { origin: 'https://browser.example.test' },
      })
      expect(preflight.status).toBe(405)
      expect(preflight.headers.get('access-control-allow-origin')).toBeNull()
    } finally {
      await runtime.close()
    }
  })

  it('composes the SDK default audience with OAuth and HTTP Transport', async () => {
    const authority = await createOAuthAuthority()
    const secretEnvironment = 'KARAKA_TRANSPORT_OAUTH_SECRET'
    process.env[secretEnvironment] = 'transport-secret'
    const shared = {
      issuer: authority.issuer,
      tokenEndpoint: `${authority.issuer}token`,
      jwksUri: `${authority.issuer}jwks`,
      clientSecretEnv: secretEnvironment,
      algorithms: ['RS256'] as Array<'RS256'>,
    }
    const runtime = await createRuntime({
      authenticationProvider: audience => new OAuthClientCredentialsProvider({
        ...shared,
        audience,
        clientId: 'karaka-server',
      }),
    })
    const client = createKarakaClient({
      endpoint: `${runtime.endpoint}/v1`,
      authentication: new OAuthClientCredentialsProvider({
        ...shared,
        audience: 'https://application.example.test',
        clientId: 'application-backend',
      }),
      user: { tenantId: 'acme', userId: 'oauth-user' },
    })

    try {
      await expect(client.chat.send({ agentId: 'support', message: 'OAuth' })).resolves.toMatchObject({
        message: { content: 'Received: OAuth' },
      })
      expect(authority.resources).toEqual([runtime.endpoint])
    } finally {
      delete process.env[secretEnvironment]
      await runtime.close()
      await authority.close()
    }
  })

  it('cancels non-streaming Agent Runtime work when its client disconnects', async () => {
    const generationStarted = Promise.withResolvers<void>()
    const generationAborted = Promise.withResolvers<void>()
    const runtime = await createRuntime({
      async installModel(ctx) {
        await ctx.plugin({
          name: 'cancellable-model',
          inject: ['agentModels'],
          apply(pluginContext) {
            pluginContext.agentModels.register({
              id: 'support-model',
              async generate(request) {
                generationStarted.resolve()
                return new Promise<never>((_resolve, reject) => {
                  request.signal?.addEventListener('abort', () => {
                    generationAborted.resolve()
                    reject(request.signal?.reason)
                  }, { once: true })
                })
              },
            })
          },
        })
      },
    })
    const client = createKarakaClient({
      endpoint: `${runtime.endpoint}/v1`,
      authentication,
      user: { tenantId: 'acme', userId: 'user-a' },
    })

    try {
      const controller = new AbortController()
      const call = client.chat.send({ agentId: 'support', message: 'Wait' }, { signal: controller.signal })
      await generationStarted.promise
      controller.abort()

      await expect(call).rejects.toMatchObject({ code: 'ABORTED' })
      await expect(within(generationAborted.promise)).resolves.toBeUndefined()
    } finally {
      await runtime.close()
    }
  })

  it('releases a backpressured stream when its client disconnects', async () => {
    const streamStarted = Promise.withResolvers<void>()
    const streamReleased = Promise.withResolvers<void>()
    const content = 'x'.repeat(4 * 1024 * 1024)
    const runtime = await createRuntime({
      async installModel(ctx) {
        await ctx.plugin({
          name: 'backpressured-model',
          inject: ['agentModels'],
          apply(pluginContext) {
            pluginContext.agentModels.register({
              id: 'support-model',
              async generate() {
                return { message: { role: 'assistant', content } }
              },
              async *stream() {
                try {
                  streamStarted.resolve()
                  yield { type: 'text-delta', delta: content } as const
                  yield { type: 'completed', generation: { message: { role: 'assistant', content } } } as const
                } finally {
                  streamReleased.resolve()
                }
              },
            })
          },
        })
      },
    })

    try {
      const controller = new AbortController()
      const response = await fetch(`${runtime.endpoint}/v1/chats`, {
        method: 'POST',
        headers: {
          accept: EVENT_STREAM_MEDIA_TYPE,
          authorization: 'Bearer application-server',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          agentId: 'support',
          message: 'Large',
          user: { tenantId: 'acme', userId: 'user-a' },
        }),
        signal: controller.signal,
      })
      expect(response.status).toBe(200)
      await streamStarted.promise
      controller.abort()

      await expect(within(streamReleased.promise)).resolves.toBeUndefined()
    } finally {
      await runtime.close()
    }
  })
})

interface RuntimeOptions {
  authenticationProvider?(audience: string): AuthenticationProvider
  installModel?(ctx: CordisContext): Promise<void>
}

async function createRuntime(options: RuntimeOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'karaka-transport-'))
  const port = await availablePort()
  const endpoint = `http://127.0.0.1:${port}`
  const ctx = new Context()

  try {
    await ctx.plugin(Authentication)
    await ctx.plugin({
      name: 'test-server-authentication',
      inject: ['authentication'],
      apply(pluginContext) {
        pluginContext.authentication.register(options.authenticationProvider?.(endpoint) ?? {
          challenge: 'Bearer',
          async authenticate(request) {
            if (request.headers.get('authorization') !== 'Bearer application-server') throw new Error('untrusted server')
            return {
              id: 'application-server',
              provider: 'test-server',
              claims: {},
            }
          },
          name: 'test-server',
          request(_target, request, dispatch) {
            return dispatch(request)
          },
        })
      },
    })
    await ctx.plugin(Entitlement)
    await ctx.plugin(Storage)
    await ctx.plugin(StorageLocal, { path: join(directory, 'storage.sqlite') })
    await ctx.plugin(AgentRuntime)
    await ctx.plugin(SessionStorage, {})
    if (options.installModel) await options.installModel(ctx)
    else await ctx.plugin(EchoModel, { id: 'support-model', prefix: 'Received: ' })
    await ctx.plugin(agentPlugin)
    await ctx.plugin(HttpTransport, {
      host: '127.0.0.1',
      port,
    })

    return {
      endpoint,
      async close() {
        await ctx.fiber.dispose()
        await rm(directory, { recursive: true, force: true })
      },
    }
  } catch (error) {
    await ctx.fiber.dispose()
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}

async function createOAuthAuthority() {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true })
  const publicJwk = { ...await exportJWK(publicKey), alg: 'RS256', kid: 'transport-key', use: 'sig' }
  const resources: string[] = []
  let issuer = ''
  const server = createServer(async (request, response) => {
    if (request.url === '/jwks') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ keys: [publicJwk] }))
      return
    }
    if (request.url !== '/token' || request.method !== 'POST') {
      response.writeHead(404).end()
      return
    }
    const authorization = request.headers.authorization ?? ''
    const decoded = authorization.startsWith('Basic ')
      ? Buffer.from(authorization.slice('Basic '.length), 'base64').toString('utf8')
      : ''
    const separator = decoded.indexOf(':')
    const clientId = decoded.slice(0, separator)
    const secret = decoded.slice(separator + 1)
    const body = new URLSearchParams(await readText(request))
    const resource = body.get('resource')
    if (!clientId || secret !== 'transport-secret' || body.get('grant_type') !== 'client_credentials' || !resource) {
      response.writeHead(401).end()
      return
    }
    resources.push(resource)
    const token = await new SignJWT({ client_id: clientId })
      .setProtectedHeader({ alg: 'RS256', kid: 'transport-key' })
      .setIssuer(issuer)
      .setAudience(resource)
      .setSubject(clientId)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey)
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ access_token: token, token_type: 'Bearer', expires_in: 300 }))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
  return {
    issuer,
    resources,
    async close() {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve())
      })
    },
  }
}

async function readText(request: IncomingMessage) {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

const authentication = {
  async request(_target: { audience: string }, request: Request, dispatch: (request: Request) => Promise<Response>) {
    const headers = new Headers(request.headers)
    headers.set('authorization', 'Bearer application-server')
    return dispatch(new Request(request, { headers }))
  },
}

const agentPlugin = {
  name: 'support-agent',
  inject: ['agentRuntime', 'agentModels'],
  apply(ctx: CordisContext) {
    ctx.agentRuntime.registerAgent({
      id: 'support',
      prompt: 'You are a support agent.',
      model: 'support-model',
    }, ctx.agentModels)
  },
}

async function availablePort() {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = (server.address() as AddressInfo).port
  await new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve())
  })
  return port
}

async function within<T>(promise: Promise<T>, timeoutMs = 1_000): Promise<T> {
  let timeout: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('operation did not finish')), timeoutMs)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}
