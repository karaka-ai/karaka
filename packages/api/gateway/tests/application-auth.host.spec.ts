import { EventEmitter, on, once } from 'node:events'
import { Context, Service } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import { ApplicationId, TenantId, UserId } from '@deepseek-ai/dsh-session'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import Typert from '@deepseek-ai/dsh-typert-registry'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import Gateway, { type TypertRemoteEventDispatch, type TypertRemoteEventOutcome } from '../src/index.ts'
import type { RemoteEventReadyFrame, RemoteEventInvocationFrame } from '../src/stream-protocol.ts'
import type { TypertContextMap, TypertContextWire } from '@deepseek-ai/dsh-typert-protocol'
import { provideBrowserCredentials } from './browser-credentials.ts'

const roots: Context[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
})

class CallerProbe extends TypertRemoteService {
  constructor(ctx: Context) { super(ctx, 'callerProbe', { namespace: 'probe' }) }
  @Remote
  async who(): Promise<string> {
    await Promise.resolve()
    const caller = this.ctx.connectionCaller
    return caller?.kind === 'application' ? caller.owner.userId : 'host'
  }
  @Remote({ mode: 'stream' })
  async *follow(signal: AbortSignal): AsyncIterable<string> {
    yield await this.who()
    await new Promise<void>((resolve) => {
      if (signal.aborted) resolve()
      else signal.addEventListener('abort', () => { resolve() }, { once: true })
    })
  }
}

class AuthProbe extends Service implements Connection.ConnectionAuth {
  constructor(ctx: Context) { super(ctx, 'connectionAuth') }
  authenticate(token: string): ReturnType<Connection.ConnectionAuth['authenticate']> {
    if (!['alice', 'bob', 'other-app', 'other-tenant'].includes(token)) return Promise.resolve(undefined)
    return Promise.resolve({ kind: 'application', owner: {
      applicationId: ApplicationId(token === 'other-app' ? 'other' : 'app'),
      tenantId: TenantId(token === 'other-tenant' ? 'other' : 'tenant'),
      userId: UserId(token.startsWith('other-') ? 'alice' : token),
    }, expiresAt: Date.now() + 60_000 })
  }
}

async function fixture() {
  const ctx = new Context()
  roots.push(ctx)
  provideBrowserCredentials(ctx)
  const auth = await ctx.plugin(AuthProbe)
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  await ctx.plugin(Connection, { authentication: 'application', frontendOrigins: ['https://frontend.example'] })
  await ctx.plugin(Typert)
  await ctx.plugin(Gateway, {})
  await ctx.plugin(CallerProbe)
  const revoke = ctx.typertGateway.registerAccessPolicy({
    allows: (_caller, endpoint) => endpoint === 'probe/who' || endpoint === 'probe/follow', receives: () => false,
  })
  const endpoint = `http://127.0.0.1:${ctx.webServer.port}`
  const invoke = async (token: string, method = 'probe/who', origin = 'https://frontend.example') => {
    const response = await fetch(`${endpoint}/api/${method}`, {
      method: 'POST', headers: { origin, authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'rpc', method, payload: { args: {} } }),
    })
    return { status: response.status, body: response.ok ? await response.json() as { result: unknown } : await response.text() }
  }
  return { ctx, endpoint, invoke, auth, revoke }
}

describe('authenticated application invocation', () => {
  it('keeps concurrent callers isolated through Cordis service dispatch', async () => {
    const { invoke } = await fixture()
    const results = await Promise.all([invoke('alice'), invoke('bob'), invoke('alice')])
    expect(results.map(result => (result.body as { result: unknown }).result)).toEqual([
      { ok: true, value: 'alice' }, { ok: true, value: 'bob' }, { ok: true, value: 'alice' },
    ])
  })

  it('enforces credentials, frontend origin and server capability policy', async () => {
    const { invoke, endpoint, revoke } = await fixture()
    expect((await invoke('invalid')).status).toBe(401)
    expect((await invoke('alice', 'probe/who', 'https://attacker.example')).status).toBe(403)
    const preflight = await fetch(`${endpoint}/api/probe/who`, { method: 'OPTIONS', headers: { origin: 'https://frontend.example' } })
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get('access-control-allow-origin')).toBe('https://frontend.example')
    revoke()
    expect(((await invoke('alice')).body as { result: { error: { code: string } } }).result.error.code).toBe('gateway/forbidden')
  })

  it('fails closed when the verification provider is withdrawn', async () => {
    const { invoke, auth } = await fixture()
    expect((await invoke('alice')).status).toBe(200)
    await auth.dispose()
    expect((await invoke('alice')).status).toBe(401)
  })

  it('authenticates WebSocket streams and ends them when access is withdrawn', async () => {
    const { endpoint, revoke } = await fixture()
    const socket = new WebSocket(`${endpoint.replace('http:', 'ws:')}/api/remote.mux`, ['dsh', 'dsh.bearer.alice'], { origin: 'https://frontend.example' })
    const frames: unknown[] = []
    socket.on('message', (data) => { frames.push(JSON.parse(Buffer.from(data as Buffer).toString('utf8')) as unknown) })
    try {
      await once(socket, 'open')
      socket.send(JSON.stringify({ type: 'open', streamId: 'follow', endpoint: 'probe/follow', payload: { args: {} } }))
      await vi.waitFor(() => { expect(frames).toContainEqual({ type: 'item', streamId: 'follow', value: 'alice' }) })
      revoke()
      await vi.waitFor(() => { expect(frames.some(frame => (frame as { type: string }).type === 'end' || (frame as { type: string }).type === 'error')).toBe(true) })
    } finally {
      const closed = once(socket, 'close')
      socket.terminate()
      await closed
    }
  })
})

async function socketClient(endpoint: string, token: string) {
  const socket = new WebSocket(`${endpoint.replace('http:', 'ws:')}/api/remote.mux`, ['dsh', `dsh.bearer.${token}`], { origin: 'https://frontend.example' })
  const frames: { type: string; streamId: string; value?: RemoteEventReadyFrame | RemoteEventInvocationFrame }[] = []
  socket.on('message', (data) => {
    frames.push(JSON.parse(Buffer.from(data as Buffer).toString('utf8')) as typeof frames[number])
  })
  await once(socket, 'open')
  socket.send(JSON.stringify({ type: 'open', streamId: 'events', endpoint: '$events', payload: { args: {} } }))
  await vi.waitFor(() => { expect(frames.some(frame => frame.value?.type === 'ready')).toBe(true) })
  const ready = frames.find(frame => frame.value?.type === 'ready')!.value as RemoteEventReadyFrame
  return { socket, frames, ready }
}

async function closeSocket(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return
  const closed = once(socket, 'close')
  socket.terminate()
  await closed
}

async function eventFixture() {
  const base = await fixture()
  base.revoke()
  const emitter = new EventEmitter()
  let deliver = true
  const policy = {
    allows: (_caller: Connection.ConnectionCaller, endpoint: string) => endpoint === '$events' || endpoint === '$events/result',
    receives: (caller: Connection.ConnectionCaller, event: TypertRemoteEventDispatch) => {
      if (!deliver || caller.kind !== 'application' || !('context' in event)) return false
      return (event.context.subject as { user: string }).user === caller.owner.userId
    },
  }
  const revoke = base.ctx.typertGateway.registerAccessPolicy(policy)
  base.ctx.typert.contexts.registerHost('agent', {
    wire: 'agentId', wireTypeSymbol: '@fixture/auth#AgentId',
    identity: () => 'chat' as TypertContextWire<TypertContextMap['agent']>,
    resolve: () => base.ctx,
  })
  const unregister = base.ctx.typertGateway.registerRemoteEvents((signal) => {
    const events = on(emitter, 'dispatch', { signal })
    return (async function *(): AsyncIterable<TypertRemoteEventDispatch> {
      try {
        for await (const [event] of events) yield event as TypertRemoteEventDispatch
      } catch (error) {
        if (!signal.aborted) throw error
      }
    })()
  }, { home: '/private/host' })
  base.ctx.effect(() => unregister)
  const pending = (user: string) => {
    const settled = Promise.withResolvers<TypertRemoteEventOutcome>()
    void settled.promise.catch(() => {})
    const subject = { ctx: base.ctx, user }
    emitter.emit('dispatch', {
      event: 'approval/request', request: { agent: subject, reason: user },
      context: { value: base.ctx, subject }, resolve: settled.resolve, reject: settled.reject,
    } satisfies TypertRemoteEventDispatch)
    return settled.promise
  }
  const answer = async (token: string, clientId: string, eventId: string) => {
    const response = await fetch(`${base.endpoint}/api/$events/result`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'answer', method: '$events/result', payload: {
        args: { clientId, eventId, outcome: { kind: 'result', value: 'allowed-once' } },
      } }),
    })
    return (await response.json() as { result: Connection.ConnectionRpcResult<unknown> }).result
  }
  return { ...base, pending, answer, revoke, policy, emitter, setDelivery(value: boolean) { deliver = value } }
}

function invocation(client: Awaited<ReturnType<typeof socketClient>>, user: string): RemoteEventInvocationFrame | undefined {
  return client.frames.map(frame => frame.value).find((value): value is RemoteEventInvocationFrame =>
    value?.type === 'waterfall' && value.request.reason === user)
}

describe('application authentication denial and event ownership', () => {
  it('rejects absent and ambiguous bearer credentials before dispatch', async () => {
    const { ctx } = await fixture()
    const headers = { host: `127.0.0.1:${ctx.webServer.port}`, origin: 'https://frontend.example' }
    for (const supplied of [
      {}, { authorization: 'Basic alice' },
      { 'sec-websocket-protocol': 'dsh' },
      { 'sec-websocket-protocol': 'dsh.bearer.alice,dsh.bearer.bob' },
      { authorization: 'Bearer alice', 'sec-websocket-protocol': 'dsh.bearer.alice' },
    ]) {
      expect(await ctx.connection.authenticate({ headers: { ...headers, ...supplied } })).toEqual({ rejection: 401 })
    }
    expect(await ctx.connection.authenticate({ headers: { host: headers.host, 'sec-fetch-site': 'cross-site', authorization: 'Bearer alice' } }))
      .toEqual({ rejection: 403 })
    const writeHead = vi.fn()
    const end = vi.fn()
    expect(ctx.connection.authorizeIndex({ method: 'GET', url: '/', headers }, { writeHead, end })).toBe(false)
    expect(writeHead).toHaveBeenCalledWith(401)
    expect(end).toHaveBeenCalledWith('unauthorized')
    expect(() => ctx.connection.authenticatedUrl('http://127.0.0.1')).toThrow('Host login is disabled')
  })

  it('keeps exact Fetch routes and non-Gateway channels Host-only', async () => {
    const { ctx, endpoint } = await fixture()
    const fetchRoute = vi.fn(async () => new Response('private'))
    const rpc = vi.fn(async () => ({ ok: true as const, value: 'private' }))
    ctx.connection.fetch.register({ path: '/api/private', methods: ['GET'], fetch: fetchRoute })
    ctx.connection.rpc.handle('/private', rpc)
    for (const path of ['/api/private', '/private/read']) {
      const response = await fetch(`${endpoint}${path}`, { headers: { authorization: 'Bearer alice' } })
      expect(response.status).toBe(403)
    }
    expect(fetchRoute).not.toHaveBeenCalled()
    expect(rpc).not.toHaveBeenCalled()
  })

  it('rejects a credential that expires while the request body is buffered', async () => {
    const { ctx, endpoint } = await fixture()
    const authentication = await ctx.connection.authenticate({ headers: { host: new URL(endpoint).host, authorization: 'Bearer alice' } })
    if ('rejection' in authentication || authentication.caller.kind !== 'application') throw new Error('credential rejected')
    const body = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>()
    const request = new Request(`${endpoint}/api/probe/who`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, duplex: 'half',
      body: new ReadableStream<Uint8Array>({ start(controller) { body.resolve(controller) } }),
    } as RequestInit)
    const response = ctx.connection.createSharedFetchHandler('/api').fetch(request, authentication.caller)
    const controller = await body.promise
    vi.spyOn(Date, 'now').mockReturnValue(authentication.caller.expiresAt + 1)
    controller.enqueue(new TextEncoder().encode(JSON.stringify({ type: 'client-request', rpcId: 'late', method: 'probe/who', payload: { args: {} } })))
    controller.close()
    expect((await response).status).toBe(401)
  })

  it('denies expired direct callers and streams without an application policy', async () => {
    const { ctx, revoke } = await fixture()
    const authentication = await ctx.connection.authenticate({ headers: { host: '127.0.0.1', authorization: 'Bearer alice' } })
    if ('rejection' in authentication || authentication.caller.kind !== 'application') throw new Error('credential rejected')
    await expect(ctx.typertGateway.invoke({ namespace: 'probe', method: 'who', args: {}, caller: { ...authentication.caller, expiresAt: 0 } }))
      .rejects.toMatchObject({ code: 'gateway/unauthorized' })
    const source = await ctx.typertGateway.stream({ namespace: 'probe', method: 'follow', args: {}, caller: authentication.caller })
    const iterator = source[Symbol.asyncIterator]()
    expect(await iterator.next()).toEqual({ done: false, value: 'alice' })
    revoke()
    await expect(iterator.next()).rejects.toMatchObject({ code: 'gateway/cancelled' })
    await expect(ctx.typertGateway.stream({ namespace: 'probe', method: 'follow', args: {}, caller: authentication.caller }))
      .rejects.toMatchObject({ code: 'gateway/forbidden' })
  })

  it('binds approval answers to the authenticated recipient and the delivered event', async () => {
    const entry = await eventFixture()
    const alice = await socketClient(entry.endpoint, 'alice')
    const bob = await socketClient(entry.endpoint, 'bob')
    const hostAbort = new AbortController()
    const host = (await entry.ctx.typertGateway.wireStream.open('$events', { args: {} }, hostAbort.signal))[Symbol.asyncIterator]()
    try {
      const hostReady = (await host.next()).value as RemoteEventReadyFrame
      expect(alice.ready.host).toEqual({ home: '' })
      expect(hostReady.host).toEqual({ home: '/private/host' })
      expect(() => entry.ctx.typertGateway.registerAccessPolicy(entry.policy)).toThrow('already registered')
      const aliceOutcome = entry.pending('alice')
      const bobOutcome = entry.pending('bob')
      await vi.waitFor(() => { expect(invocation(alice, 'alice')).toBeDefined(); expect(invocation(bob, 'bob')).toBeDefined() })
      const aliceEvent = invocation(alice, 'alice')!
      const bobEvent = invocation(bob, 'bob')!
      expect(invocation(alice, 'bob')).toBeUndefined()
      expect(invocation(bob, 'alice')).toBeUndefined()
      for (const [token, clientId, eventId] of [
        ['alice', hostReady.clientId, aliceEvent.eventId],
        ['other-app', alice.ready.clientId, aliceEvent.eventId],
        ['other-tenant', alice.ready.clientId, aliceEvent.eventId],
        ['bob', alice.ready.clientId, aliceEvent.eventId],
        ['alice', alice.ready.clientId, 'missing'],
        ['alice', alice.ready.clientId, bobEvent.eventId],
      ] as const) {
        expect(await entry.answer(token, clientId, eventId)).toMatchObject({ ok: false, error: { code: 'gateway/forbidden' } })
      }
      entry.setDelivery(false)
      expect(await entry.answer('alice', alice.ready.clientId, aliceEvent.eventId)).toMatchObject({ ok: false, error: { code: 'gateway/forbidden' } })
      entry.setDelivery(true)
      await closeSocket(alice.socket)
      const replacement = await socketClient(entry.endpoint, 'bob')
      try {
        await vi.waitFor(() => { expect(invocation(replacement, 'bob')).toBeDefined() })
        expect(invocation(replacement, 'alice')).toBeUndefined()
        expect(await entry.answer('bob', replacement.ready.clientId, aliceEvent.eventId)).toMatchObject({ ok: false })
        expect(await entry.answer('bob', replacement.ready.clientId, bobEvent.eventId)).toEqual({ ok: true })
        expect(await bobOutcome).toEqual({ kind: 'result', value: 'allowed-once' })
      } finally { await closeSocket(replacement.socket) }
      const reconnectedAlice = await socketClient(entry.endpoint, 'alice')
      try {
        await vi.waitFor(() => { expect(invocation(reconnectedAlice, 'alice')).toBeDefined() })
        expect(await entry.answer('alice', reconnectedAlice.ready.clientId, aliceEvent.eventId)).toEqual({ ok: true })
        expect(await aliceOutcome).toEqual({ kind: 'result', value: 'allowed-once' })
        entry.emitter.emit('dispatch', { event: 'host/private', args: ['private'] } satisfies TypertRemoteEventDispatch)
        let hostFrame: unknown = (await host.next()).value
        while (typeof hostFrame !== 'object' || hostFrame === null || Reflect.get(hostFrame, 'type') !== 'emit') {
          hostFrame = (await host.next()).value
        }
        expect(hostFrame).toMatchObject({ event: 'host/private', args: ['private'] })
        entry.revoke()
        entry.revoke()
        await vi.waitFor(() => { expect(reconnectedAlice.frames.some(frame => frame.type === 'end')).toBe(true) })
      } finally { await closeSocket(reconnectedAlice.socket) }
    } finally {
      hostAbort.abort()
      await host.return?.()
      await Promise.all([closeSocket(alice.socket), closeSocket(bob.socket)])
    }
  })

  it('rejects answers from an expired event generation even after HTTP credential renewal', async () => {
    const entry = await eventFixture()
    const alice = await socketClient(entry.endpoint, 'alice')
    try {
      void entry.pending('alice')
      await vi.waitFor(() => { expect(invocation(alice, 'alice')).toBeDefined() })
      const event = invocation(alice, 'alice')!
      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 120_000)
      expect(await entry.answer('alice', alice.ready.clientId, event.eventId)).toMatchObject({ ok: false, error: { code: 'gateway/forbidden' } })
    } finally { await closeSocket(alice.socket) }
  })
})
