import AgentRuntime from '@karaka/agent-runtime'
import EchoModel from '@karaka/agent-runtime/model-echo'
import SessionStorage from '@karaka/agent-runtime/session-storage'
import Authentication from '@karaka/authentication'
import { Context, type Context as CordisContext } from '@karaka/cordis'
import Entitlement from '@karaka/entitlement'
import Storage from '@karaka/storage'
import StorageLocal from '@karaka/storage/local'
import { EVENT_STREAM_MEDIA_TYPE, type TransportStreamEvent } from '@karaka/transport'
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

    try {
      const first = await sendJson(runtime.endpoint, '/v1/chats', 'user-a', {
        agentId: 'support',
        message: 'Hello',
      })
      expect(first.response.status).toBe(200)
      expect(first.body).toMatchObject({
        agentId: 'support',
        model: 'support-model',
        message: { role: 'assistant', content: 'Received: Hello' },
      })
      const chatId = requireChatId(first.body)

      const resumed = await sendJson(runtime.endpoint, `/v1/chats/${chatId}/messages`, 'user-a', {
        message: 'Again',
      })
      expect(resumed.response.status).toBe(200)
      expect(resumed.body).toMatchObject({ chatId, message: { content: 'Received: Again' } })

      const stolen = await sendJson(runtime.endpoint, `/v1/chats/${chatId}/messages`, 'user-b', {
        message: 'Steal it',
      })
      expect(stolen.response.status).toBe(404)
      expect(stolen.body).toEqual({ error: { code: 'CHAT_NOT_FOUND', message: 'chat is not available' } })
    } finally {
      await runtime.close()
    }
  })

  it('negotiates SSE and streams incremental text directly to an allowed browser origin', async () => {
    const runtime = await createRuntime()

    try {
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
})

async function createRuntime() {
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
    await ctx.plugin(EchoModel, { id: 'support-model', prefix: 'Received: ' })
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

async function sendJson(endpoint: string, path: string, subject: string, body: unknown) {
  const response = await fetch(`${endpoint}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${subject}`,
      'content-type': 'application/json',
      'x-karaka-tenant': 'acme',
    },
    body: JSON.stringify(body),
  })
  return { response, body: await response.json() as Record<string, unknown> }
}

function requireChatId(value: Record<string, unknown>) {
  if (typeof value.chatId !== 'string') throw new TypeError('transport returned no chat ID')
  return value.chatId
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
