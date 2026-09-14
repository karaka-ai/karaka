/** Browser client behavior over isolated HTTP and controlled SSE streams. */
import { createServer, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import { describe, expect, it, onTestFinished } from 'vitest'
import {
  createBrowserClient,
  SessionId,
  type BrowserClient,
  type BrowserClientConfig,
} from '../src/browser.ts'

function queue<Value>() {
  const values: Value[] = []
  const readers: ((value: Value) => void)[] = []
  return {
    push(value: Value) {
      const reader = readers.shift()
      if (reader === undefined) values.push(value)
      else reader(value)
    },
    read(): Promise<Value> {
      const value = values.shift()
      return value === undefined ? new Promise(resolve => readers.push(resolve)) : Promise.resolve(value)
    },
  }
}

interface Call {
  method: string
  body: Record<string, unknown>
  authorization: string | undefined
  response: ServerResponse
}

function json(response: ServerResponse, value: unknown, status = 200) {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(value))
}

function event(response: ServerResponse, value: unknown) {
  response.write(`data: ${JSON.stringify(value)}\n\n`)
}

function ready(response: ServerResponse, clientId = 'browser-one') {
  event(response, { type: 'ready', clientId, host: { home: '/application' } })
}

async function fixture(options: Partial<Omit<BrowserClientConfig, 'endpoint'>> = {}) {
  const connections = queue<ServerResponse>()
  const results = queue<Call>()
  const requests: Call[] = []
  const clients: BrowserClient[] = []
  let respond = (call: Call) => { json(call.response, { ok: true, value: { method: call.method } }) }
  let connect = (call: Call) => {
    call.response.writeHead(200, { 'content-type': 'text/event-stream' })
    call.response.flushHeaders()
    connections.push(call.response)
  }
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array))
      const call: Call = {
        method: request.url!.split('/').at(-1)!,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>,
        authorization: request.headers.authorization,
        response,
      }
      requests.push(call)
      if (call.method === 'events') connect(call)
      else if (call.method === 'result') {
        results.push(call)
        respond(call)
      } else respond(call)
    })().catch((error: unknown) => { response.destroy(error instanceof Error ? error : new Error(String(error))) })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  onTestFinished(async () => {
    await Promise.all(clients.map(client => client.dispose()))
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((error) => {
      if (error === undefined) resolve()
      else reject(error)
    }))
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Expected a TCP listener')
  const endpoint = `http://127.0.0.1:${address.port}`
  return {
    endpoint, connections, results, requests,
    set respond(handler: (call: Call) => void) { respond = handler },
    set connect(handler: (call: Call) => void) { connect = handler },
    async client(overrides: Partial<BrowserClientConfig> = {}) {
      const client = await createBrowserClient({ endpoint, credential: () => 'browser-token', ...options, ...overrides })
      clients.push(client)
      return client
    },
    async connected() {
      const client = await this.client()
      const stream = await connections.read()
      ready(stream)
      await stateOf(client, 'connected')
      return { client, stream }
    },
  }
}

async function stateOf(client: BrowserClient, expected: 'connecting' | 'connected' | 'disconnected') {
  if (client.connection.state.getSnapshot() === expected) return
  await new Promise<void>((resolve) => {
    const stop = client.connection.state.subscribe(() => {
      if (client.connection.state.getSnapshot() === expected) { stop(); resolve() }
    })
  })
}

function interaction(response: ServerResponse, eventId: string, chatId = 'chat-one', name = 'approval/request', request: unknown = { agent: { id: chatId }, toolName: 'application-tool' }) {
  event(response, { type: 'interaction', eventId, chatId, event: name, request })
}

const chatId = SessionId('chat-one')

describe('browser application client', () => {
  it.each([
    { endpoint: 'file:///application' },
    { endpoint: 'https://example.test/path' },
    { endpoint: 'https://example.test/?query' },
    { endpoint: 'https://example.test/#fragment' },
    { endpoint: 'https://user:password@example.test' },
    { path: 'relative' },
    { path: '/trailing/' },
    { reconnectDelayMs: 0 },
    { reconnectDelayMs: 1.5 },
  ])('rejects invalid connection settings: %j', async (options) => {
    await expect(createBrowserClient({ endpoint: 'https://example.test', credential: () => 'token', ...options })).rejects.toThrow()
  })

  it('waits for readiness and renews credentials for every method', async () => {
    let credentials = 0
    const host = await fixture({ credential: () => `token-${++credentials}`, path: '/embedded' })
    const client = await host.client()
    const waiting = client.chats.applicationAgents()
    const stream = await host.connections.read()
    expect(host.requests.map(call => call.method)).toEqual(['events'])
    ready(stream)
    expect(await waiting).toEqual({ ok: true, value: { method: 'applicationAgents' } })
    expect(client.connection.generation.getSnapshot()).toEqual({ id: 1, host: { home: '/application' } })
    const input = { chatId, agentId: 'support' }
    expect(await client.chats.applicationCreate(input)).toEqual({ ok: true, value: { method: 'applicationCreate' } })
    await client.chats.applicationPrompt({ chatId, requestId: 'request-one', content: [{ type: 'text', text: 'hello' }] })
    await client.chats.applicationHistory({ chatId })
    await client.chats.applicationCancel({ chatId })
    expect(host.requests.map(call => call.authorization)).toEqual(['Bearer token-1', 'Bearer token-2', 'Bearer token-3', 'Bearer token-4', 'Bearer token-5', 'Bearer token-6'])
    expect(host.requests[2]!.body).toEqual(input)
  })

  it('enforces the locally mounted method set', async () => {
    const host = await fixture({ methods: [] })
    const { client } = await host.connected()
    await expect(client.chats.applicationAgents()).rejects.toThrow('not mounted')
    await expect(Array.fromAsync(client.chats.applicationFollow({ chatId }))).rejects.toThrow('not mounted')
    expect(host.requests).toHaveLength(1)
  })

  it.each([401, 403, 500])('sanitizes invalid HTTP %s responses', async (status) => {
    const host = await fixture()
    host.respond = (call) => { json(call.response, { private: 'server internals' }, status) }
    const { client } = await host.connected()
    expect(await client.chats.applicationHistory({ chatId })).toEqual({
      ok: false,
      error: { code: status === 500 ? 'gateway/internal' : 'gateway/forbidden', message: status === 500 ? 'Browser response is invalid' : 'Browser access is forbidden', details: {} },
    })
  })

  it('preserves protocol failures and reports unreadable JSON', async () => {
    const host = await fixture()
    const { client } = await host.connected()
    const error = { code: 'application/not-found', message: 'Chat unavailable', details: { chatId } }
    host.respond = (call) => { json(call.response, { ok: false, error }, 404) }
    expect(await client.chats.applicationHistory({ chatId })).toEqual({ ok: false, error })
    host.respond = (call) => { call.response.end('not-json') }
    expect(await client.chats.applicationAgents()).toMatchObject({ ok: false, error: { code: 'gateway/internal' } })
  })

  it('cancels waiting requests before credentials or application HTTP calls', async () => {
    const host = await fixture()
    const client = await host.client()
    await host.connections.read()
    const controller = new AbortController()
    const waiting = client.chats.applicationAgents(controller.signal)
    controller.abort(new Error('caller cancelled'))
    expect(await waiting).toMatchObject({ ok: false, error: { message: 'caller cancelled' } })
    expect(await client.chats.applicationAgents(controller.signal)).toMatchObject({ ok: false, error: { message: 'caller cancelled' } })
    expect(host.requests).toHaveLength(1)
  })

  it('reports credential errors without exposing non-Error values', async () => {
    let fail = false
    const host = await fixture({ credential: () => { if (fail) throw 'private rejection'; return 'token' } })
    const { client } = await host.connected()
    fail = true
    expect(await client.chats.applicationAgents()).toEqual({ ok: false, error: { code: 'gateway/internal', message: 'Browser request failed', details: {} } })
  })

  it('parses split CRLF SSE data, comments, multiline JSON and a final end-of-stream', async () => {
    const host = await fixture()
    host.respond = (call) => {
      call.response.writeHead(200, { 'content-type': 'text/event-stream' })
      call.response.write(': heartbeat\r\n\r\ndata: {"ok": true,\r\n')
      call.response.write('data: "value":{"type":"text-delta","cursor":1,"text":"hello"}}\r\n\r\n')
      call.response.end('data: {"ok":false,"error":{"code":"done","message":"end","details":{}}}\n\n')
    }
    const { client } = await host.connected()
    expect(await Array.fromAsync(client.chats.applicationFollow({ chatId }))).toEqual([
      { ok: true, value: { type: 'text-delta', cursor: 1, text: 'hello' } },
      { ok: false, error: { code: 'done', message: 'end', details: {} } },
    ])
  })

  it('returns a follow HTTP failure and rejects malformed stream envelopes', async () => {
    const host = await fixture()
    const { client } = await host.connected()
    host.respond = (call) => { json(call.response, { bad: true }, 403) }
    expect(await Array.fromAsync(client.chats.applicationFollow({ chatId }))).toMatchObject([{ ok: false, error: { code: 'gateway/forbidden' } }])
    host.respond = (call) => { call.response.end('data: {"unexpected":true}\n\n') }
    expect(await Array.fromAsync(client.chats.applicationFollow({ chatId }))).toMatchObject([{ ok: false, error: { code: 'gateway/internal' } }])
    host.respond = (call) => { call.response.writeHead(204); call.response.end() }
    expect(await Array.fromAsync(client.chats.applicationFollow({ chatId }))).toMatchObject([{ ok: false, error: { message: 'Browser event response has no body' } }])
  })

  it('ends cancelled follows without reporting cancellation as an application failure', async () => {
    const host = await fixture()
    const { client } = await host.connected()
    const controller = new AbortController()
    controller.abort()
    expect(await Array.fromAsync(client.chats.applicationFollow({ chatId }, controller.signal))).toEqual([])
    const following = queue<ServerResponse>()
    host.respond = (call) => { call.response.writeHead(200); call.response.flushHeaders(); following.push(call.response) }
    const live = new AbortController()
    const collected = Array.fromAsync(client.chats.applicationFollow({ chatId }, live.signal))
    await following.read()
    live.abort()
    expect(await collected).toEqual([])
  })

  it('reconnects explicitly and notifies subscribers of a new generation', async () => {
    const host = await fixture()
    const { client } = await host.connected()
    const generations: (number | undefined)[] = []
    const stop = client.connection.generation.subscribe(() => { generations.push(client.connection.generation.getSnapshot()?.id) })
    client.connection.reconnect()
    expect(client.connection.state.getSnapshot()).toBe('connecting')
    const stream = await host.connections.read()
    ready(stream, 'browser-two')
    await stateOf(client, 'connected')
    expect(client.connection.generation.getSnapshot()?.id).toBe(2)
    expect(generations).toContain(undefined)
    expect(generations.at(-1)).toBe(2)
    stop()
    await client.dispose()
    expect(client.connection.state.getSnapshot()).toBe('disconnected')
    expect(() => { client.connection.reconnect() }).toThrow('disposed')
  })

  it('retries ended and rejected event connections', async () => {
    const host = await fixture({ reconnectDelayMs: 1 })
    let attempts = 0
    host.connect = (call) => {
      attempts++
      if (attempts === 1) { call.response.writeHead(403); call.response.end(); return }
      call.response.writeHead(200)
      call.response.flushHeaders()
      host.connections.push(call.response)
    }
    const client = await host.client()
    const first = await host.connections.read()
    ready(first)
    await stateOf(client, 'connected')
    first.end()
    const second = await host.connections.read()
    ready(second)
    await stateOf(client, 'connected')
    expect(attempts).toBe(3)
    expect(client.connection.generation.getSnapshot()?.id).toBe(2)
  })

  it('rejects interactions before readiness and reconnects', async () => {
    const host = await fixture({ reconnectDelayMs: 1 })
    const client = await host.client()
    const first = await host.connections.read()
    interaction(first, 'early')
    const second = await host.connections.read()
    ready(second)
    await stateOf(client, 'connected')
    expect(host.requests.filter(call => call.method === 'result')).toEqual([])
  })

  it('routes approvals by chat, honors handler order and removes subscriptions', async () => {
    const host = await fixture()
    const { client, stream } = await host.connected()
    const calls: string[] = []
    const offFirst = client.forChat(chatId).$on('approval/request', async (request, next) => {
      calls.push(request.toolName)
      return await next()
    })
    const offSecond = client.forChat(chatId).$on('approval/request', () => 'allowed-once')
    interaction(stream, 'approval-one')
    expect((await host.results.read()).body).toEqual({ clientId: 'browser-one', eventId: 'approval-one', outcome: { kind: 'result', value: 'allowed-once' } })
    expect(calls).toEqual(['application-tool'])
    interaction(stream, 'other-chat', 'chat-two')
    expect((await host.results.read()).body.outcome).toEqual({ kind: 'next' })
    offSecond()
    interaction(stream, 'delegated')
    expect((await host.results.read()).body.outcome).toEqual({ kind: 'next' })
    offFirst()
    interaction(stream, 'removed')
    expect((await host.results.read()).body.outcome).toEqual({ kind: 'next' })
  })

  it('validates question callbacks and delegates when all handlers defer', async () => {
    const host = await fixture()
    const { client, stream } = await host.connected()
    const scope = client.forChat(chatId)
    const offFirst = scope.$on('user-questions/request', async (request, next) => {
      expect(request.questions[0]!.id).toBe('choice')
      return await next()
    })
    const answer = { answers: [{ id: 'choice', selected: ['a'], custom: 'detail' }, { id: 'second', selected: [] }] }
    const offSecond = scope.$on('user-questions/request', () => answer)
    const request = { agent: { id: chatId }, questions: [{ id: 'choice', question: 'Choose', options: [{ label: 'a' }] }] }
    interaction(stream, 'question', chatId, 'user-questions/request', request)
    expect((await host.results.read()).body.outcome).toEqual({ kind: 'result', value: answer })
    offSecond()
    interaction(stream, 'question-next', chatId, 'user-questions/request', request)
    expect((await host.results.read()).body.outcome).toEqual({ kind: 'next' })
    offFirst()
  })

  it('delegates failed handlers, malformed interactions and rejected answers', async () => {
    const host = await fixture()
    const { client, stream } = await host.connected()
    const off = client.forChat(chatId).$on('approval/request', () => { throw new Error('UI failed') })
    interaction(stream, 'throwing')
    expect((await host.results.read()).body.outcome).toEqual({ kind: 'next' })
    off()
    client.forChat(chatId).$on('approval/request', () => 'rejected')
    interaction(stream, 'malformed', chatId, 'approval/request', {})
    expect((await host.results.read()).body.outcome).toEqual({ kind: 'next' })
    let responses = 0
    host.respond = (call) => { json(call.response, {}, ++responses === 1 ? 409 : 200) }
    interaction(stream, 'server-rejected')
    expect((await host.results.read()).body.outcome).toEqual({ kind: 'result', value: 'rejected' })
    expect((await host.results.read()).body.outcome).toEqual({ kind: 'next' })
  })

  it('deduplicates active interactions and cancels answerers without replying', async () => {
    const host = await fixture()
    const { client, stream } = await host.connected()
    const entered = queue<AbortSignal>()
    let count = 0
    client.forChat(chatId).$on('approval/request', (request) => {
      count++
      entered.push(request.signal)
      return new Promise((resolve) => { request.signal.addEventListener('abort', () => { resolve('cancelled') }, { once: true }) })
    })
    interaction(stream, 'pending')
    const signal = await entered.read()
    interaction(stream, 'pending')
    event(stream, { type: 'cancel', eventId: 'pending' })
    event(stream, { type: 'cancel', eventId: 'unknown' })
    if (!signal.aborted) await once(signal, 'abort')
    expect(count).toBe(1)
    await client.dispose()
    expect(host.requests.filter(call => call.method === 'result')).toEqual([])
  })

  it('disposes a pending callback and waits for cancellation delivery', async () => {
    const host = await fixture()
    const { client, stream } = await host.connected()
    const entered = queue<AbortSignal>()
    client.forChat(chatId).$on('approval/request', (request) => {
      entered.push(request.signal)
      return new Promise((resolve) => { request.signal.addEventListener('abort', () => { resolve('cancelled') }, { once: true }) })
    })
    interaction(stream, 'pending-dispose')
    const signal = await entered.read()
    await client.dispose()
    expect(signal.aborted).toBe(true)
    expect(client.connection.generation.getSnapshot()).toBeUndefined()
    expect(await client.chats.applicationAgents()).toMatchObject({ ok: false, error: { message: 'Browser client disposed' } })
  })

  it('replaces a connection during its retry delay', async () => {
    const host = await fixture({ reconnectDelayMs: 60_000 })
    const { client, stream } = await host.connected()
    const connecting = stateOf(client, 'connecting')
    stream.end()
    await connecting
    client.connection.reconnect()
    const replacement = await host.connections.read()
    ready(replacement)
    await stateOf(client, 'connected')
    expect(client.connection.generation.getSnapshot()?.id).toBe(2)
  })

  it('contains an observer failure and still notifies other observers', async () => {
    const host = await fixture()
    const { client } = await host.connected()
    const stopThrowing = client.connection.generation.subscribe(() => { throw new Error('observer failed') })
    const observed: (number | undefined)[] = []
    const stopObserving = client.connection.generation.subscribe(() => { observed.push(client.connection.generation.getSnapshot()?.id) })
    client.connection.reconnect()
    const stream = await host.connections.read()
    ready(stream)
    await stateOf(client, 'connected')
    expect(observed.at(-1)).toBe(2)
    stopThrowing()
    stopObserving()
  })

  it('does not send an answer when reconnect wins after callback settlement', async () => {
    const host = await fixture()
    const { client, stream } = await host.connected()
    const entered = queue<AbortSignal>()
    const answer = Promise.withResolvers<'allowed-once'>()
    client.forChat(chatId).$on('approval/request', (request) => {
      entered.push(request.signal)
      return answer.promise
    })
    interaction(stream, 'settled-before-reconnect')
    const signal = await entered.read()
    answer.resolve('allowed-once')
    // The nested microtask places reconnect after callback settlement but before
    // the interaction's awaiting continuation, without a timer or scheduling guess.
    queueMicrotask(() => { queueMicrotask(() => { client.connection.reconnect() }) })
    const replacement = await host.connections.read()
    ready(replacement)
    await stateOf(client, 'connected')
    expect(signal.aborted).toBe(true)
    expect(host.requests.filter(call => call.method === 'result')).toEqual([])
  })

  it('sanitizes a non-Error cancellation reason while waiting for readiness', async () => {
    const host = await fixture()
    const client = await host.client()
    await host.connections.read()
    const controller = new AbortController()
    const request = client.chats.applicationAgents(controller.signal)
    controller.abort('caller-owned reason')
    expect(await request).toMatchObject({ ok: false, error: { message: 'Browser request failed' } })
  })

})
