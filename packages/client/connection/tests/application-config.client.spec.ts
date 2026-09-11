import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, type BrowserConnectionConfig, type ConnectionHandle } from '../src/client/index.ts'
import { createWebConnectionRpc } from '../src/client/rpc.ts'

const roots: Context[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
  vi.unstubAllGlobals()
})

async function mount(config: BrowserConnectionConfig): Promise<ConnectionHandle> {
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin({ apply }, config)
  return ctx.get('connection') as ConnectionHandle
}

describe('application browser connection configuration', () => {
  it('keeps page fetch available to RPC callers without a transport override', async () => {
    vi.stubGlobal('location', { origin: 'https://host.example' })
    const fetcher = vi.fn((url: URL, init: RequestInit) => {
      expect(url.href).toBe('https://host.example/api/session/list')
      const request = JSON.parse(init.body as string) as { rpcId: string }
      return Promise.resolve(Response.json({ type: 'server-response', rpcId: request.rpcId, result: { ok: true, value: [] } }))
    })
    vi.stubGlobal('fetch', fetcher)
    await expect(createWebConnectionRpc().call('/api', 'session/list', {})).resolves.toEqual({ ok: true, value: [] })
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it.each(['ftp://server', 'https://server/path', 'https://server/?q=1', 'https://server/#hash',
    'https://user@server/', 'https://:password@server/'])('rejects non-origin endpoint %s', async (endpoint) => {
    await expect(mount({ endpoint })).rejects.toThrow('HTTP(S) server origin')
  })

  it('renews HTTP and WebSocket credentials independently for each client', async () => {
    const requests: { url: string; token: string | null }[] = []
    vi.stubGlobal('fetch', (url: URL, init: RequestInit) => {
      const request = JSON.parse(init.body as string) as { rpcId: string }
      requests.push({ url: url.href, token: new Headers(init.headers).get('authorization') })
      return Promise.resolve(Response.json({ type: 'server-response', rpcId: request.rpcId, result: { ok: true, value: 'done' } }))
    })
    let token = 'alice'
    const alice = await mount({ endpoint: 'https://karaka.example', credential: () => token })
    const bob = await mount({ endpoint: 'http://127.0.0.1:1234', credential: () => 'bob' })
    expect(alice.isLoopback).toBe(false)
    expect(bob.isLoopback).toBe(false)
    await alice.rpc.call('/api', 'session/applicationAgents', {})
    await bob.rpc.call('/api', 'session/applicationAgents', {}, new AbortController().signal)
    token = 'renewed'
    await alice.rpc.call('/api', 'session/applicationAgents', {})
    expect(requests).toEqual([
      { url: 'https://karaka.example/api/session/applicationAgents', token: 'Bearer alice' },
      { url: 'http://127.0.0.1:1234/api/session/applicationAgents', token: 'Bearer bob' },
      { url: 'https://karaka.example/api/session/applicationAgents', token: 'Bearer renewed' },
    ])
    await expect(alice.webSocketOptions!('/api/remote.mux', new AbortController().signal)).resolves.toEqual({
      url: 'wss://karaka.example/api/remote.mux', protocols: ['dsh', 'dsh.bearer.renewed'],
    })
    const local = await mount({ endpoint: 'http://localhost:1234' })
    expect(local.isLoopback).toBe(true)
    await expect(local.webSocketOptions!('/api/remote.mux', new AbortController().signal)).resolves.toEqual({
      url: 'ws://localhost:1234/api/remote.mux', protocols: [],
    })
  })

  it('uses the page origin for credentials without an explicit endpoint', async () => {
    vi.stubGlobal('location', { hostname: 'frontend.example', origin: 'https://frontend.example', search: '' })
    const handle = await mount({ credential: () => 'user' })
    await expect(handle.webSocketOptions!('/api/remote.mux', new AbortController().signal)).resolves.toMatchObject({
      url: 'wss://frontend.example/api/remote.mux',
    })
    vi.stubGlobal('location', undefined)
    const noOrigin = await mount({ credential: () => 'user' })
    await expect(noOrigin.webSocketOptions!('/api/remote.mux', new AbortController().signal)).rejects.toThrow()
  })

  it('does not send or open after credential acquisition is cancelled', async () => {
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    const abort = new AbortController()
    const handle = await mount({ endpoint: 'https://server.example', credential: (signal) => {
      expect(signal).toBe(abort.signal)
      abort.abort(new Error('cancelled'))
      return 'late-token'
    } })
    await expect(handle.rpc.call('/api', 'session/applicationAgents', {}, abort.signal)).rejects.toThrow('cancelled')
    await expect(handle.webSocketOptions!('/api/remote.mux', abort.signal)).rejects.toThrow('cancelled')
    expect(fetcher).not.toHaveBeenCalled()
  })
})
