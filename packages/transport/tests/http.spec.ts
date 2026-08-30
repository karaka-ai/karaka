import AgentRuntime from '@karaka/agent-runtime'
import EchoModel from '@karaka/agent-runtime/model-echo'
import SessionStorage from '@karaka/agent-runtime/session-storage'
import Authentication from '@karaka/authentication'
import { Context, type Context as CordisContext } from '@karaka/cordis'
import Entitlement from '@karaka/entitlement'
import { createKarakaClient, EVENT_STREAM_MEDIA_TYPE, type TransportStreamEvent } from '@karaka/sdk'
import Storage from '@karaka/storage'
import StorageLocal from '@karaka/storage/local'
import HttpTransport from '@karaka/transport/http'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const origin = 'https://app.example.test'

describe('HTTP Transport', () => {
  it('authenticates JSON chat turns and preserves durable ownership', async () => {
    const runtime = await createRuntime()
    const userA = createKarakaClient({
      endpoint: `${runtime.endpoint}/v1`,
      credentials: { tenantId: 'acme', token: 'user-a' },
    })
    const userB = createKarakaClient({
      endpoint: `${runtime.endpoint}/v1`,
      credentials: { tenantId: 'acme', token: 'user-b' },
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

  it('negotiates SSE and streams incremental text directly to an allowed browser origin', async () => {
    const runtime = await createRuntime()
    const client = createKarakaClient({
      endpoint: `${runtime.endpoint}/v1`,
      credentials: { tenantId: 'acme', token: 'sdk-user' },
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

      const response = await fetch(`${runtime.endpoint}/v1/chats`, {
        method: 'POST',
        headers: {
          accept: EVENT_STREAM_MEDIA_TYPE,
          authorization: 'Bearer browser-user',
          'content-type': 'application/json',
          origin,
          'x-karaka-tenant': 'acme',
        },
        body: JSON.stringify({ agentId: 'support', message: 'Hello' }),
      })

      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toContain(EVENT_STREAM_MEDIA_TYPE)
      expect(response.headers.get('access-control-allow-origin')).toBe(origin)
      expect(parseEvents(await response.text())).toEqual([
        { type: 'text-delta', delta: 'Received: ' },
        { type: 'text-delta', delta: 'Hello' },
        {
          type: 'completed',
          result: {
            chatId: expect.any(String),
            agentId: 'support',
            model: 'support-model',
            message: { role: 'assistant', content: 'Received: Hello' },
          },
        },
      ])
    } finally {
      await runtime.close()
    }
  })

  it('rejects missing credentials and unconfigured browser origins', async () => {
    const runtime = await createRuntime()

    try {
      const unauthenticated = await fetch(`${runtime.endpoint}/v1/chats`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-karaka-tenant': 'acme' },
        body: JSON.stringify({ agentId: 'support', message: 'Hello' }),
      })
      expect(unauthenticated.status).toBe(401)
      await expect(unauthenticated.json()).resolves.toEqual({
        error: { code: 'INVALID_REQUEST', message: 'authentication failed' },
      })

      const forbidden = await fetch(`${runtime.endpoint}/v1/chats`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer user-a',
          'content-type': 'application/json',
          origin: 'https://evil.example.test',
          'x-karaka-tenant': 'acme',
        },
        body: JSON.stringify({ agentId: 'support', message: 'Hello' }),
      })
      expect(forbidden.status).toBe(403)
      await expect(forbidden.json()).resolves.toEqual({
        error: { code: 'ORIGIN_NOT_ALLOWED', message: 'origin not allowed' },
      })
    } finally {
      await runtime.close()
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
      credentials: { tenantId: 'acme', token: 'user-a' },
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
          authorization: 'Bearer user-a',
          'content-type': 'application/json',
          'x-karaka-tenant': 'acme',
        },
        body: JSON.stringify({ agentId: 'support', message: 'Large' }),
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
  installModel?(ctx: CordisContext): Promise<void>
}

async function createRuntime(options: RuntimeOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'karaka-transport-'))
  const port = await availablePort()
  const ctx = new Context()

  try {
    await ctx.plugin(Authentication)
    await ctx.plugin({
      name: 'test-token-authentication',
      inject: ['authentication'],
      apply(pluginContext) {
        pluginContext.authentication.register({
          name: 'test-token',
          tenantIds: ['acme'],
          async authenticate(request) {
            return {
              tenantId: request.tenantId,
              subject: request.token,
              provider: 'test-token',
              claims: {},
            }
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
      corsOrigins: [origin],
    })

    return {
      endpoint: `http://127.0.0.1:${port}`,
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

function parseEvents(body: string): TransportStreamEvent[] {
  return body.trim().split('\n\n').map(block => {
    const data = block.split('\n').find(line => line.startsWith('data: '))
    if (!data) throw new TypeError('stream event has no data')
    return JSON.parse(data.slice('data: '.length)) as TransportStreamEvent
  })
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
