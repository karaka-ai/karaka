import { once } from 'node:events'
import { createConnection } from 'node:net'
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as TransportHttp from '@karaka/transport-http'

const roots: Context[] = []

afterEach(async () => {
  await Promise.allSettled(roots.splice(0).map(ctx => ctx.fiber.dispose()))
})

async function harness(options: {
  readonly holdStream?: boolean
  readonly followError?: Error
  readonly followAfterSnapshotError?: Error
  readonly snapshotCursor?: number
  readonly snapshotRecords?: readonly unknown[]
  readonly nextFrameGate?: Promise<void>
  readonly listAgents?: (signal?: AbortSignal) => Promise<readonly { readonly id: string; readonly name: string }[]>
  readonly create?: () => Promise<{ readonly chatId: string; readonly agentId: string }>
  readonly prompt?: () => Promise<{ readonly accepted: true; readonly duplicate: boolean }>
  readonly events?: () => Promise<readonly unknown[]>
  readonly authenticate?: (
    authorization: string | undefined,
    signal?: AbortSignal,
  ) => Promise<{ readonly applicationId: string } | undefined>
} = {}) {
  const ctx = new Context()
  roots.push(ctx)
  const create = vi.fn(options.create ?? (() => Promise.resolve({ chatId: 'chat-1', agentId: 'support' })))
  const streamAbort = vi.fn()
  const application = {
    listAgents: options.listAgents ?? (() => Promise.resolve([{ id: 'support', name: 'Support' }])),
    create,
    prompt: options.prompt ?? (() => Promise.resolve({ accepted: true, duplicate: false })),
    events: options.events ?? (() => Promise.resolve([])),
    cancel: () => Promise.resolve({ accepted: true }),
    selectModel: (request: { provider: string; model: string }) => Promise.resolve({
      selected: { provider: request.provider, model: request.model },
    }),
    async *follow(_request: unknown, signal: AbortSignal) {
      if (options.followError !== undefined) throw options.followError
      signal.addEventListener('abort', streamAbort, { once: true })
      const snapshotCursor = options.snapshotCursor ?? -1
      yield { type: 'snapshot' as const, cursor: snapshotCursor, records: options.snapshotRecords ?? [] }
      if (options.followAfterSnapshotError !== undefined) throw options.followAfterSnapshotError
      await options.nextFrameGate
      if (options.holdStream === true) {
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => {
            resolve()
          }, { once: true })
        })
        return
      }
      yield {
        type: 'event' as const,
        event: {
          type: 'assistant/chunk',
          seq: snapshotCursor + 1,
          data: { chunk: { type: 'text-delta', text: 'hello' } },
        },
      }
    },
  }
  const authenticate = vi.fn(options.authenticate ?? ((authorization: string | undefined) => Promise.resolve(
    authorization === 'Bearer valid' ? { applicationId: 'billing' } : undefined,
  )))
  ctx.provide('serverAuth', {
    authenticate,
  } as never)
  ctx.provide('sessionController', { application } as never)
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  const transport = await ctx.plugin(TransportHttp, { path: '/v1' })
  return {
    ctx, transport, create, streamAbort, authenticate,
    endpoint: `http://127.0.0.1:${String(ctx.webServer.port)}`,
  }
}

describe('Karaka HTTP transport', () => {
  it('authenticates the application and derives durable chat ownership', async () => {
    const { create, endpoint } = await harness()
    const unauthorized = await fetch(`${endpoint}/v1/agents`)
    expect(unauthorized.status).toBe(401)

    const response = await fetch(`${endpoint}/v1/chats`, {
      method: 'POST',
      headers: { authorization: 'Bearer valid', 'content-type': 'application/json' },
      body: JSON.stringify({ chatId: 'chat-1', agentId: 'support', tenantId: 'tenant-1', userId: 'user-1' }),
    })
    expect(response.status).toBe(201)
    expect(create).toHaveBeenCalledWith(
      {
        chatId: 'chat-1',
        agentId: 'support',
        owner: { applicationId: 'billing', tenantId: 'tenant-1', userId: 'user-1' },
      },
      expect.any(AbortSignal),
    )
  })

  it('validates request bodies and streams stable SSE events', async () => {
    const { endpoint } = await harness()
    const invalid = await fetch(`${endpoint}/v1/chats`, {
      method: 'POST',
      headers: { authorization: 'Bearer valid', 'content-type': 'application/json' },
      body: JSON.stringify({ chatId: 'chat-1', agentId: 'support', tenantId: '', userId: 'user-1' }),
    })
    expect(invalid.status).toBe(400)

    const stream = await fetch(`${endpoint}/v1/chats/chat-1/stream`, {
      method: 'POST',
      headers: { authorization: 'Bearer valid', 'content-type': 'application/json' },
      body: JSON.stringify({ tenantId: 'tenant-1', userId: 'user-1' }),
    })
    expect(stream.status).toBe(200)
    const body = await stream.text()
    expect(body).toContain('"type":"snapshot"')
    expect(body).toContain('"type":"text-delta"')
    expect(body).toContain('"text":"hello"')
  })

  it('maps public failures and hides unexpected internal diagnostics', async () => {
    const missing = Object.assign(new Error('private storage path'), { code: 'session/not-found' })
    const missingHarness = await harness({ events: () => Promise.reject(missing) })
    const notFound = await fetch(`${missingHarness.endpoint}/v1/chats/missing/history`, {
      method: 'POST',
      headers: { authorization: 'Bearer valid', 'content-type': 'application/json' },
      body: JSON.stringify({ tenantId: 'tenant-1', userId: 'user-1' }),
    })
    expect(notFound.status).toBe(404)
    await expect(notFound.json()).resolves.toEqual({ code: 'CHAT_NOT_FOUND', message: 'Chat not found' })

    const internalHarness = await harness({
      listAgents: () => Promise.reject(new Error('database password leaked')),
    })
    const internal = await fetch(`${internalHarness.endpoint}/v1/agents`, {
      headers: { authorization: 'Bearer valid' },
    })
    expect(internal.status).toBe(500)
    await expect(internal.json()).resolves.toEqual({ code: 'INTERNAL_ERROR', message: 'Internal server error' })
  })

  it('maps real Agent Preset and attachment validation failures to caller errors', async () => {
    for (const [code, status, exposed] of [
      ['agent-preset/not-found', 404, 'AGENT_NOT_FOUND'],
      ['agent-preset/invalid', 400, 'BAD_REQUEST'],
    ] as const) {
      const fixture = await harness({
        create: () => Promise.reject(Object.assign(new Error('private preset detail'), { code })),
      })
      const response = await fetch(`${fixture.endpoint}/v1/chats`, {
        method: 'POST',
        headers: { authorization: 'Bearer valid', 'content-type': 'application/json' },
        body: JSON.stringify({ chatId: 'chat-1', agentId: 'missing', tenantId: 'tenant-1', userId: 'user-1' }),
      })
      expect(response.status).toBe(status)
      await expect(response.json()).resolves.toMatchObject({ code: exposed })
    }

    const attachment = await harness({
      prompt: () => Promise.reject(Object.assign(new Error('private attachment detail'), {
        code: 'session/attachment-invalid',
      })),
    })
    const response = await fetch(`${attachment.endpoint}/v1/chats/chat-1/messages`, {
      method: 'POST',
      headers: { authorization: 'Bearer valid', 'content-type': 'application/json' },
      body: JSON.stringify({
        tenantId: 'tenant-1',
        userId: 'user-1',
        requestId: 'request-1',
        content: [{ type: 'image', mediaType: 'image/png', data: 'invalid' }],
      }),
    })
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({ code: 'BAD_REQUEST', message: 'Invalid request' })
  })

  it('replays snapshot records in cursor order before its checkpoint', async () => {
    const { endpoint } = await harness({
      snapshotCursor: 4,
      snapshotRecords: [
        { type: 'event', event: { type: 'assistant/chunk', seq: 2, data: { chunk: { type: 'text-delta', text: 'old' } } } },
        { type: 'event', event: { type: 'assistant/message', seq: 3, data: { message: { role: 'assistant' } } } },
      ],
    })
    const response = await fetch(`${endpoint}/v1/chats/chat-1/stream`, {
      method: 'POST',
      headers: { authorization: 'Bearer valid', 'content-type': 'application/json' },
      body: JSON.stringify({ tenantId: 'tenant-1', userId: 'user-1', cursor: 1 }),
    })
    const body = await response.text()

    expect(body.indexOf('"cursor":2')).toBeLessThan(body.indexOf('"cursor":3'))
    expect(body.indexOf('"cursor":3')).toBeLessThan(body.indexOf('"type":"snapshot","cursor":4'))
    expect(body.indexOf('"type":"snapshot","cursor":4')).toBeLessThan(body.indexOf('"cursor":5'))
  })

  it('projects direct user messages into history and SSE in durable order', async () => {
    const user = {
      type: 'user/message',
      seq: 1,
      data: {
        id: 'user-1',
        role: 'user',
        content: [{ type: 'text', text: 'Help me' }],
        source: { kind: 'user', rpcId: 'request-1' },
      },
    }
    const assistant = {
      type: 'assistant/message',
      seq: 2,
      data: { message: { id: 'assistant-1', role: 'assistant', content: [{ type: 'text', text: 'Sure' }] } },
    }
    const { endpoint } = await harness({
      events: () => Promise.resolve([user, assistant]),
      snapshotCursor: 2,
      snapshotRecords: [
        { type: 'event', event: user },
        { type: 'event', event: assistant },
      ],
    })
    const request = {
      method: 'POST',
      headers: { authorization: 'Bearer valid', 'content-type': 'application/json' },
      body: JSON.stringify({ tenantId: 'tenant-1', userId: 'user-1' }),
    } as const

    const history = await fetch(`${endpoint}/v1/chats/chat-1/history`, request)
    await expect(history.json()).resolves.toMatchObject({
      events: [
        { type: 'user-message', cursor: 1, content: user.data },
        { type: 'assistant-message', cursor: 2 },
      ],
    })

    const stream = await fetch(`${endpoint}/v1/chats/chat-1/stream`, request)
    const body = await stream.text()
    expect(body.indexOf('"type":"user-message","cursor":1'))
      .toBeLessThan(body.indexOf('"type":"assistant-message","cursor":2'))
  })

  it('preserves tool call identity when parallel results complete out of order', async () => {
    const { endpoint } = await harness({
      snapshotCursor: 3,
      snapshotRecords: [
        { type: 'event', event: { type: 'tool/call', seq: 0, data: { callId: 'call-1', name: 'first', arguments: '{}' } } },
        { type: 'event', event: { type: 'tool/call', seq: 1, data: { callId: 'call-2', name: 'second', arguments: '{}' } } },
        { type: 'event', event: { type: 'tool/result', seq: 2, data: { message: { source: { callId: 'call-2' }, content: [] } } } },
        { type: 'event', event: { type: 'tool/result', seq: 3, data: { message: { source: { callId: 'call-1' }, content: [] } } } },
      ],
    })
    const response = await fetch(`${endpoint}/v1/chats/chat-1/stream`, {
      method: 'POST',
      headers: { authorization: 'Bearer valid', 'content-type': 'application/json' },
      body: JSON.stringify({ tenantId: 'tenant-1', userId: 'user-1' }),
    })
    const body = await response.text()

    expect(body).toContain('"type":"tool-call","cursor":0,"callId":"call-1"')
    expect(body).toContain('"type":"tool-call","cursor":1,"callId":"call-2"')
    expect(body.indexOf('"type":"tool-result","cursor":2,"callId":"call-2"'))
      .toBeLessThan(body.indexOf('"type":"tool-result","cursor":3,"callId":"call-1"'))
  })

  it('opens with the durable snapshot before replaying a pending interaction', async () => {
    const { ctx, endpoint } = await harness({ holdStream: true, snapshotCursor: 4 })
    const questionAbort = new AbortController()
    const asking = ctx.waterfall('user-questions/request', {
      agent: {
        id: 'chat-1',
        session: {
          header: {
            applicationOwner: { applicationId: 'billing', tenantId: 'tenant-1', userId: 'user-1' },
          },
          events: [{ seq: 4 }],
        },
      } as never,
      questions: [{ id: 'confirm', question: 'Continue?' }],
      signal: questionAbort.signal,
    }, () => Promise.reject(new Error('no answerer')))
    const response = await fetch(`${endpoint}/v1/chats/chat-1/stream`, {
      method: 'POST',
      headers: { authorization: 'Bearer valid', 'content-type': 'application/json' },
      body: JSON.stringify({ tenantId: 'tenant-1', userId: 'user-1' }),
    })
    const reader = response.body?.getReader()
    expect(reader).toBeDefined()
    const decoder = new TextDecoder()
    let body = ''
    while (!body.includes('interaction-required')) {
      const chunk = await reader?.read()
      if (chunk?.done === true || chunk?.value === undefined) break
      body += decoder.decode(chunk.value, { stream: true })
    }

    expect(body.indexOf('"type":"snapshot"')).toBeGreaterThanOrEqual(0)
    expect(body.indexOf('"type":"snapshot"')).toBeLessThan(body.indexOf('"type":"interaction-required"'))
    questionAbort.abort()
    await reader?.cancel()
    await expect(asking).rejects.toBeDefined()
  })

  it('delivers durable events through an interaction cursor before the interaction', async () => {
    const gate = Promise.withResolvers<undefined>()
    const { ctx, endpoint } = await harness({ snapshotCursor: 4, nextFrameGate: gate.promise })
    const response = await fetch(`${endpoint}/v1/chats/chat-1/stream`, {
      method: 'POST',
      headers: { authorization: 'Bearer valid', 'content-type': 'application/json' },
      body: JSON.stringify({ tenantId: 'tenant-1', userId: 'user-1' }),
    })
    const reader = response.body?.getReader()
    const decoder = new TextDecoder()
    let body = decoder.decode((await reader?.read())?.value, { stream: true })
    const questionAbort = new AbortController()
    const asking = ctx.waterfall('user-questions/request', {
      agent: {
        id: 'chat-1',
        session: {
          header: { applicationOwner: { applicationId: 'billing', tenantId: 'tenant-1', userId: 'user-1' } },
          events: [{ seq: 5 }],
        },
      } as never,
      questions: [{ id: 'confirm', question: 'Continue?' }],
      signal: questionAbort.signal,
    }, () => Promise.reject(new Error('no answerer')))
    await Promise.resolve()
    expect(body).not.toContain('interaction-required')

    gate.resolve(undefined)
    while (!body.includes('interaction-required')) {
      const chunk = await reader?.read()
      if (chunk?.done === true || chunk?.value === undefined) break
      body += decoder.decode(chunk.value, { stream: true })
    }
    expect(body.indexOf('"cursor":5')).toBeLessThan(body.indexOf('"type":"interaction-required"'))
    questionAbort.abort()
    await reader?.cancel()
    await expect(asking).rejects.toBeDefined()
  })

  it('rejects a reconnect cursor beyond the durable snapshot before SSE headers', async () => {
    const { endpoint } = await harness({ snapshotCursor: 4 })
    const response = await fetch(`${endpoint}/v1/chats/chat-1/stream`, {
      method: 'POST',
      headers: { authorization: 'Bearer valid', 'content-type': 'application/json' },
      body: JSON.stringify({ tenantId: 'tenant-1', userId: 'user-1', cursor: 5 }),
    })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('aborts and drains an active stream during plugin disposal', async () => {
    const { transport, endpoint, streamAbort } = await harness({ holdStream: true })
    const stream = await fetch(`${endpoint}/v1/chats/chat-1/stream`, {
      method: 'POST',
      headers: { authorization: 'Bearer valid', 'content-type': 'application/json' },
      body: JSON.stringify({ tenantId: 'tenant-1', userId: 'user-1' }),
    })
    const body = stream.text()
    await transport.dispose()
    await expect(Promise.allSettled([body])).resolves.toHaveLength(1)
    expect(streamAbort).toHaveBeenCalledOnce()
  })

  it('aborts an unfinished request body during plugin disposal', async () => {
    const { transport, endpoint, authenticate } = await harness()
    const url = new URL(endpoint)
    const socket = createConnection({ host: url.hostname, port: Number(url.port) })
    socket.on('error', () => undefined)
    await once(socket, 'connect')
    socket.write([
      'POST /v1/chats HTTP/1.1',
      `Host: ${url.host}`,
      'Authorization: Bearer valid',
      'Content-Type: application/json',
      'Content-Length: 100',
      '',
      '{',
    ].join('\r\n'))
    await vi.waitFor(() => { expect(authenticate).toHaveBeenCalledOnce() })
    const closed = once(socket, 'close')

    await expect(transport.dispose()).resolves.toBeUndefined()
    await closed
  })

  it('propagates transport disposal to admitted authentication', async () => {
    const started = Promise.withResolvers<undefined>()
    const aborted = vi.fn()
    const { transport, endpoint } = await harness({
      authenticate: (_authorization, signal) => new Promise((_resolve, reject) => {
        started.resolve(undefined)
        signal?.addEventListener('abort', () => {
          aborted()
          reject(signal.reason instanceof Error ? signal.reason : new Error('authentication cancelled'))
        }, { once: true })
      }),
    })
    const request = fetch(`${endpoint}/v1/agents`, { headers: { authorization: 'Bearer valid' } })
    await started.promise

    await expect(transport.dispose()).resolves.toBeUndefined()
    await expect(Promise.allSettled([request])).resolves.toHaveLength(1)
    expect(aborted).toHaveBeenCalledOnce()
  })

  it('cancels and drains an admitted controller operation during plugin disposal', async () => {
    const started = Promise.withResolvers<undefined>()
    const aborted = vi.fn()
    const { transport, endpoint } = await harness({
      listAgents: signal => new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          aborted()
          reject(signal.reason instanceof Error ? signal.reason : new Error('controller operation cancelled'))
        }, { once: true })
        started.resolve(undefined)
      }),
    })
    const request = fetch(`${endpoint}/v1/agents`, {
      headers: { authorization: 'Bearer valid' },
    })
    await started.promise

    await expect(transport.dispose()).resolves.toBeUndefined()
    await expect(Promise.allSettled([request])).resolves.toHaveLength(1)
    expect(aborted).toHaveBeenCalledOnce()
  })

  it('rejects a forbidden stream before committing SSE headers', async () => {
    const error = Object.assign(new Error('forbidden'), { code: 'CHAT_FORBIDDEN' })
    const { endpoint } = await harness({ followError: error })
    const response = await fetch(`${endpoint}/v1/chats/chat-1/stream`, {
      method: 'POST',
      headers: { authorization: 'Bearer valid', 'content-type': 'application/json' },
      body: JSON.stringify({ tenantId: 'tenant-1', userId: 'user-1' }),
    })

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toMatchObject({ code: 'CHAT_FORBIDDEN' })
  })

  it('delivers a stream failure after the opening snapshot', async () => {
    const error = Object.assign(new Error('lost durable follower'), { code: 'FOLLOW_FAILED' })
    const { endpoint } = await harness({ followAfterSnapshotError: error })
    const response = await fetch(`${endpoint}/v1/chats/chat-1/stream`, {
      method: 'POST',
      headers: { authorization: 'Bearer valid', 'content-type': 'application/json' },
      body: JSON.stringify({ tenantId: 'tenant-1', userId: 'user-1' }),
    })

    expect(response.status).toBe(200)
    expect(await response.text()).toContain('"type":"error","code":"INTERNAL_ERROR"')
  })

  it('aborts server-side following when the client closes the response body', async () => {
    const { endpoint, streamAbort } = await harness({ holdStream: true })
    const response = await fetch(`${endpoint}/v1/chats/chat-1/stream`, {
      method: 'POST',
      headers: { authorization: 'Bearer valid', 'content-type': 'application/json' },
      body: JSON.stringify({ tenantId: 'tenant-1', userId: 'user-1' }),
    })
    const reader = response.body?.getReader()
    expect(reader).toBeDefined()
    await reader?.read()
    await reader?.cancel()

    await vi.waitFor(() => { expect(streamAbort).toHaveBeenCalledOnce() })
  })
})
