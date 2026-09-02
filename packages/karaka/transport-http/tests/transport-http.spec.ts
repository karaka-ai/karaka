import { EventEmitter, once } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createConnection } from 'node:net'
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as TransportHttp from '@karaka-ai/transport-http'

const roots: Context[] = []

afterEach(async () => {
  await Promise.allSettled(roots.splice(0).map(ctx => ctx.fiber.dispose()))
})

async function harness(options: {
  readonly config?: TransportHttp.Config
  readonly holdStream?: boolean
  readonly omitSnapshot?: boolean
  readonly openingFrame?: unknown
  readonly followFrames?: readonly unknown[]
  readonly followError?: Error
  readonly followAfterSnapshotError?: Error
  readonly snapshotCursor?: number
  readonly snapshotRecords?: readonly unknown[]
  readonly nextFrameGate?: Promise<void>
  readonly listAgents?: (signal?: AbortSignal) => Promise<readonly { readonly id: string; readonly name: string }[]>
  readonly create?: () => Promise<{ readonly chatId: string; readonly agentId: string }>
  readonly prompt?: (request: unknown) => Promise<{ readonly accepted: true; readonly duplicate: boolean }>
  readonly events?: () => Promise<readonly unknown[]>
  readonly cancel?: (request: unknown) => Promise<{ readonly accepted: true }>
  readonly selectModel?: (request: { provider: string; model: string; reasoningEffort?: string }) => Promise<{
    readonly selected: { readonly provider: string; readonly model: string; readonly reasoningEffort?: string }
  }>
  readonly authenticate?: (
    authorization: string | undefined,
    signal?: AbortSignal,
  ) => Promise<{ readonly applicationId: string } | undefined>
} = {}) {
  const ctx = new Context()
  roots.push(ctx)
  const create = vi.fn(options.create ?? (() => Promise.resolve({ chatId: 'chat-1', agentId: 'support' })))
  const prompt = vi.fn(options.prompt ?? (() => Promise.resolve({ accepted: true, duplicate: false })))
  const cancel = vi.fn(options.cancel ?? (() => Promise.resolve({ accepted: true })))
  const selectModel = vi.fn(options.selectModel ?? ((request: {
    provider: string
    model: string
    reasoningEffort?: string
  }) => Promise.resolve({
    selected: {
      provider: request.provider,
      model: request.model,
      ...(request.reasoningEffort === undefined ? {} : { reasoningEffort: request.reasoningEffort }),
    },
  })))
  const streamAbort = vi.fn()
  const application = {
    listAgents: options.listAgents ?? (() => Promise.resolve([{ id: 'support', name: 'Support' }])),
    create,
    prompt,
    events: options.events ?? (() => Promise.resolve([])),
    cancel,
    selectModel,
    async *follow(_request: unknown, signal: AbortSignal) {
      if (options.followError !== undefined) throw options.followError
      signal.addEventListener('abort', streamAbort, { once: true })
      const snapshotCursor = options.snapshotCursor ?? -1
      if (options.omitSnapshot !== true) {
        yield options.openingFrame ?? {
          type: 'snapshot' as const, cursor: snapshotCursor, records: options.snapshotRecords ?? [],
        }
      }
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
      if (options.followFrames !== undefined) {
        yield* options.followFrames
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
  const transport = await ctx.plugin(TransportHttp, options.config ?? { path: '/v1' })
  return {
    ctx, transport, create, prompt, cancel, selectModel, streamAbort, authenticate,
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

  it('serves the complete application route matrix', async () => {
    const { endpoint, prompt, cancel, selectModel } = await harness()
    const headers = { authorization: 'Bearer valid', 'content-type': 'application/json' }
    const identity = { tenantId: 'tenant-1', userId: 'user-1' }

    const agents = await fetch(`${endpoint}/v1/agents`, { headers })
    await expect(agents.json()).resolves.toEqual([{ id: 'support', name: 'Support' }])
    expect((await fetch(`${endpoint}/v1/missing`, { headers })).status).toBe(404)
    expect((await fetch(`${endpoint}/v1/chats/chat-1/history`, { headers })).status).toBe(404)

    const message = await fetch(`${endpoint}/v1/chats/chat%2F1/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        ...identity,
        requestId: 'request-1',
        content: [
          { type: 'text', text: 'hello' },
          { type: 'image', mediaType: 'image/png', data: 'encoded', name: 'chart.png' },
        ],
      }),
    })
    expect(message.status).toBe(202)
    await expect(message.json()).resolves.toMatchObject({
      chatId: 'chat/1', requestId: 'request-1', accepted: true, duplicate: false,
    })
    expect(prompt).toHaveBeenCalledWith(expect.objectContaining({
      chatId: 'chat/1',
      content: [
        { type: 'text', text: 'hello' },
        { type: 'image', mediaType: 'image/png', data: 'encoded', name: 'chart.png' },
      ],
    }), expect.any(AbortSignal))

    const cancelled = await fetch(`${endpoint}/v1/chats/chat-1/cancel`, {
      method: 'POST', headers, body: JSON.stringify(identity),
    })
    expect(cancelled.status).toBe(200)
    expect(cancel).toHaveBeenCalledOnce()

    for (const model of [
      { provider: 'deepseek', model: 'chat' },
      { provider: 'deepseek', model: 'reasoner', reasoningEffort: 'high' },
    ]) {
      const response = await fetch(`${endpoint}/v1/chats/chat-1/model`, {
        method: 'POST', headers, body: JSON.stringify({ ...identity, ...model }),
      })
      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toEqual({ selected: model })
    }
    expect(selectModel).toHaveBeenCalledTimes(2)
  })

  it('answers only the pending interaction owned by the addressed chat', async () => {
    const { ctx, endpoint } = await harness({ holdStream: true })
    const asking = ctx.waterfall('user-questions/request', {
      agent: {
        id: 'chat-1',
        session: {
          header: { applicationOwner: { applicationId: 'billing', tenantId: 'tenant-1', userId: 'user-1' } },
          events: [],
        },
      } as never,
      questions: [{ id: 'confirm', question: 'Continue?' }],
    }, () => Promise.reject(new Error('no answerer')))
    await Promise.resolve()
    const stream = await fetch(`${endpoint}/v1/chats/chat-1/stream`, {
      method: 'POST',
      headers: { authorization: 'Bearer valid', 'content-type': 'application/json' },
      body: JSON.stringify({ tenantId: 'tenant-1', userId: 'user-1' }),
    })
    const reader = stream.body?.getReader()
    const decoder = new TextDecoder()
    let body = ''
    while (!body.includes('interaction-required')) {
      const chunk = await reader?.read()
      if (chunk?.done === true || chunk?.value === undefined) break
      body += decoder.decode(chunk.value, { stream: true })
    }
    const interactionId = /"interactionId":"([^"]+)"/u.exec(body)?.[1]
    expect(interactionId).toBeDefined()
    const headers = { authorization: 'Bearer valid', 'content-type': 'application/json' }
    const wrong = await fetch(`${endpoint}/v1/chats/other/responses`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        tenantId: 'tenant-1', userId: 'user-1', interactionId,
        answers: { answers: [{ id: 'confirm', selected: ['yes'] }] },
      }),
    })
    expect(wrong.status).toBe(403)

    const answered = await fetch(`${endpoint}/v1/chats/chat-1/responses`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        tenantId: 'tenant-1', userId: 'user-1', interactionId,
        answers: { answers: [
          { id: 'confirm', selected: ['yes'] },
          { id: 'detail', selected: [], custom: 'because' },
        ] },
      }),
    })
    expect(answered.status).toBe(200)
    await expect(asking).resolves.toEqual({
      answers: [
        { id: 'confirm', selected: ['yes'] },
        { id: 'detail', selected: [], custom: 'because' },
      ],
    })
    await reader?.cancel()
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

  it.each([
    ['SESSION_QUERY_SESSION_NOT_FOUND', 404, 'CHAT_NOT_FOUND'],
    ['agent-preset/conflict', 409, 'CHAT_CONFLICT'],
    ['session/conflict', 409, 'CHAT_CONFLICT'],
    ['session/agent-busy', 409, 'CHAT_CONFLICT'],
    ['session/model-unavailable', 400, 'BAD_REQUEST'],
    ['gateway/bad-request', 400, 'BAD_REQUEST'],
  ] as const)('maps %s to its stable application error', async (code, status, exposed) => {
    const fixture = await harness({
      events: () => Promise.reject(Object.assign(new Error('private detail'), { code })),
    })
    const response = await fetch(`${fixture.endpoint}/v1/chats/chat-1/history`, {
      method: 'POST',
      headers: { authorization: 'Bearer valid', 'content-type': 'application/json' },
      body: JSON.stringify({ tenantId: 'tenant-1', userId: 'user-1' }),
    })

    expect(response.status).toBe(status)
    await expect(response.json()).resolves.toMatchObject({ code: exposed })
  })

  it('rejects malformed and oversized JSON bodies', async () => {
    const { endpoint } = await harness({ config: { path: '/v1', maxBodyBytes: 16 } })
    const headers = { authorization: 'Bearer valid', 'content-type': 'application/json' }
    for (const body of ['{', 'null', '[]', JSON.stringify({ tenantId: 'too-long-for-limit' })]) {
      const response = await fetch(`${endpoint}/v1/chats`, { method: 'POST', headers, body })
      expect(response.status).toBe(400)
      await expect(response.json()).resolves.toMatchObject({ code: 'BAD_REQUEST' })
    }
  })

  it('uses default route settings and rejects invalid route prefixes', async () => {
    const fixture = await harness({ config: {} })
    const response = await fetch(`${fixture.endpoint}/v1/agents`, {
      headers: { authorization: 'Bearer valid' },
    })
    expect(response.status).toBe(200)

    const ctx = new Context()
    ctx.provide('serverAuth', {} as never)
    ctx.provide('sessionController', {} as never)
    ctx.provide('webServer', {} as never)
    expect(() => { TransportHttp.apply(ctx, { path: '/' }) }).toThrow(/path/u)
    expect(() => { TransportHttp.apply(ctx, { path: 'v1' }) }).toThrow(/path/u)
    expect(() => { TransportHttp.apply(ctx, { path: '/v1/' }) }).toThrow(/path/u)
    await ctx.fiber.dispose()
  })

  it('applies raw defaults and treats a request without a URL as the root route', async () => {
    const ctx = new Context()
    roots.push(ctx)
    let handler: ((request: IncomingMessage, response: ServerResponse) => Promise<void>) | undefined
    ctx.provide('serverAuth', {
      authenticate: () => Promise.resolve({ applicationId: 'billing' }),
    } as never)
    ctx.provide('sessionController', { application: {} } as never)
    ctx.provide('webServer', {
      register: (route: { handler: typeof handler }) => {
        handler = route.handler
        return () => undefined
      },
    } as never)
    await ctx.plugin({
      name: 'raw-transport-http-test',
      apply(child: Context) { TransportHttp.apply(child, {}) },
    })
    const request = Object.assign(new EventEmitter(), {
      method: 'GET', headers: { authorization: 'Bearer valid' }, destroy: vi.fn(),
    }) as unknown as IncomingMessage
    const writeHead = vi.fn()
    const end = vi.fn()
    const response = Object.assign(new EventEmitter(), {
      destroyed: false, headersSent: false, writeHead, end, destroy: vi.fn(),
    }) as unknown as ServerResponse

    await handler?.(request, response)

    expect(writeHead).toHaveBeenCalledWith(404, { 'content-type': 'application/json; charset=utf-8' })
    expect(end).toHaveBeenCalledWith(JSON.stringify({ code: 'NOT_FOUND', message: 'Route not found' }))
  })

  it('delegates questions without an application-owned Agent', async () => {
    const { ctx } = await harness()
    const next = vi.fn(() => Promise.resolve({ answers: [] }))

    await expect(ctx.waterfall('user-questions/request', {
      questions: [],
    } as never, next)).resolves.toEqual({ answers: [] })
    await expect(ctx.waterfall('user-questions/request', {
      agent: { session: { header: {} } }, questions: [],
    } as never, next)).resolves.toEqual({ answers: [] })
    expect(next).toHaveBeenCalledTimes(2)
  })

  it('cancels an interaction once when its signal has no reason', async () => {
    const { ctx } = await harness()
    let abort: (() => void) | undefined
    const signal = {
      reason: undefined,
      addEventListener: (_name: string, listener: () => void) => { abort = listener },
      removeEventListener: vi.fn(),
    } as unknown as AbortSignal
    const asking = ctx.waterfall('user-questions/request', {
      agent: {
        id: 'chat-1',
        session: {
          header: { applicationOwner: { applicationId: 'billing', tenantId: 'tenant-1', userId: 'user-1' } },
          events: [],
        },
      } as never,
      questions: [{ id: 'confirm', question: 'Continue?' }],
      signal,
    }, () => Promise.reject(new Error('no answerer')))
    await Promise.resolve()
    abort?.()
    abort?.()

    await expect(asking).rejects.toThrow('Interaction was cancelled')
  })

  it('rejects pending questions when the transport is disposed', async () => {
    const { ctx, transport } = await harness()
    const asking = ctx.waterfall('user-questions/request', {
      agent: {
        id: 'chat-1',
        session: {
          header: { applicationOwner: { applicationId: 'billing', tenantId: 'tenant-1', userId: 'user-1' } },
          events: [],
        },
      } as never,
      questions: [{ id: 'confirm', question: 'Continue?' }],
    }, () => Promise.reject(new Error('no answerer')))
    await Promise.resolve()

    await transport.dispose()

    await expect(asking).rejects.toThrow(/disposed/u)
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

  it('projects the complete durable event vocabulary and ignores internal records', async () => {
    const events = [
      { type: 'user/message', seq: 0, data: { source: { kind: 'system' } } },
      { type: 'assistant/chunk', seq: 1, data: { chunk: { type: 'usage', text: 'hidden' } } },
      { type: 'tool/call', seq: 2, data: { callId: 2, name: 'bad', arguments: '{}' } },
      { type: 'tool/result', seq: 3, data: { message: {} } },
      { type: 'tool/result', seq: 4, data: { result: { ok: true }, message: { source: { callId: 'call-1' } } } },
      { type: 'tool/result', seq: 5, data: { message: { source: { callId: 'call-2' }, value: 'message' } } },
      { type: 'tool/result', seq: 6, data: { source: { callId: 'call-3' } } },
      { type: 'turn/end', seq: 7, data: { reason: 'complete' } },
      { type: 'internal/event', seq: 8, data: {} },
    ]
    const fixture = await harness({ events: () => Promise.resolve(events) })
    const response = await fetch(`${fixture.endpoint}/v1/chats/chat-1/history`, {
      method: 'POST',
      headers: { authorization: 'Bearer valid', 'content-type': 'application/json' },
      body: JSON.stringify({ tenantId: 'tenant-1', userId: 'user-1' }),
    })
    const body = await response.json() as { events: unknown[] }

    expect(body.events).toEqual([
      { type: 'tool-result', cursor: 4, callId: 'call-1', content: { ok: true } },
      { type: 'tool-result', cursor: 5, callId: 'call-2', content: events[5]?.data.message },
      { type: 'turn-end', cursor: 7, reason: 'complete' },
    ])
  })

  it('rejects missing or invalid opening stream frames', async () => {
    for (const options of [
      { omitSnapshot: true, followFrames: [] },
      { openingFrame: { type: 'event', event: { type: 'turn/end', seq: 0, data: {} } } },
    ]) {
      const fixture = await harness(options)
      const response = await fetch(`${fixture.endpoint}/v1/chats/chat-1/stream`, {
        method: 'POST',
        headers: { authorization: 'Bearer valid', 'content-type': 'application/json' },
        body: JSON.stringify({ tenantId: 'tenant-1', userId: 'user-1' }),
      })
      expect(response.status).toBe(500)
    }
  })

  it('filters replayed and live events at the reconnect cursor', async () => {
    const fixture = await harness({
      snapshotCursor: 3,
      snapshotRecords: [
        { type: 'metadata' },
        { type: 'event', event: { type: 'turn/end', seq: 1, data: { reason: 'old' } } },
        { type: 'event', event: { type: 'turn/end', seq: 2, data: { reason: 'current' } } },
      ],
      followFrames: [
        { type: 'event', event: { type: 'turn/end', seq: 2, data: { reason: 'skipped' } } },
        { type: 'snapshot', cursor: 4, records: [] },
        { type: 'event', event: { type: 'turn/end', seq: 5, data: { reason: 'new' } } },
      ],
    })
    const response = await fetch(`${fixture.endpoint}/v1/chats/chat-1/stream`, {
      method: 'POST',
      headers: { authorization: 'Bearer valid', 'content-type': 'application/json' },
      body: JSON.stringify({ tenantId: 'tenant-1', userId: 'user-1', cursor: 2 }),
    })
    const body = await response.text()

    expect(body).not.toContain('old')
    expect(body).not.toContain('current')
    expect(body).not.toContain('skipped')
    expect(body).toContain('"cursor":4')
    expect(body).toContain('new')
  })

  it('ignores pending interactions owned by another chat', async () => {
    const { ctx, endpoint } = await harness()
    const abort = new AbortController()
    const asking = ctx.waterfall('user-questions/request', {
      agent: {
        id: 'other-chat',
        session: {
          header: { applicationOwner: { applicationId: 'billing', tenantId: 'tenant-1', userId: 'user-1' } },
          events: [],
        },
      } as never,
      questions: [{ id: 'confirm', question: 'Continue?' }],
      signal: abort.signal,
    }, () => Promise.reject(new Error('no answerer')))
    await Promise.resolve()
    const response = await fetch(`${endpoint}/v1/chats/chat-1/stream`, {
      method: 'POST',
      headers: { authorization: 'Bearer valid', 'content-type': 'application/json' },
      body: JSON.stringify({ tenantId: 'tenant-1', userId: 'user-1' }),
    })

    expect(await response.text()).not.toContain('interaction-required')
    abort.abort()
    await expect(asking).rejects.toBeDefined()
  })

  it('maps primitive controller failures without exposing them', async () => {
    const fixture = await harness({
      // The service boundary accepts unknown failures, including primitives.
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors
      listAgents: () => Promise.reject('private failure'),
    })
    const response = await fetch(`${fixture.endpoint}/v1/agents`, {
      headers: { authorization: 'Bearer valid' },
    })

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toEqual({ code: 'INTERNAL_ERROR', message: 'Internal server error' })
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

  it('keeps a shared chat subscription while another stream remains active', async () => {
    const { endpoint } = await harness({ holdStream: true })
    const request = {
      method: 'POST',
      headers: { authorization: 'Bearer valid', 'content-type': 'application/json' },
      body: JSON.stringify({ tenantId: 'tenant-1', userId: 'user-1' }),
    } as const
    const first = await fetch(`${endpoint}/v1/chats/chat-1/stream`, request)
    const second = await fetch(`${endpoint}/v1/chats/chat-1/stream`, request)
    const firstReader = first.body?.getReader()
    const secondReader = second.body?.getReader()
    await firstReader?.read()
    await secondReader?.read()

    await firstReader?.cancel()
    await Promise.resolve()
    await secondReader?.cancel()
  })
})
