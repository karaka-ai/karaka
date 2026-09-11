import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createBrowserClient } from '../src/client/browser.ts'

// Source tests supply one descriptor without requiring generated lib artifacts.
// The packed composition suite exercises the complete generated contribution.
vi.mock('@deepseek-ai/dsh-api-remotes/client', () => ({
  APPLICATION_REMOTE_METHODS: ['applicationAgents'],
  inject: ['remote'], name: 'browser-fixture', Config: undefined, provide: undefined, intercept: undefined,
  apply: async (ctx: Context) => ctx.remote.$mount({
    package: '@fixture/browser',
    descriptors: [{
      id: '@fixture/browser#session/applicationAgents', service: 'sessionController', namespace: 'session',
      method: 'applicationAgents', invocation: { kind: 'direct' }, parameters: [],
      result: { mode: 'strict', typeSymbol: '@fixture/browser#AgentRows', schema: z.array(z.object({ id: z.string() })) },
    }],
  }),
}))

afterEach(() => { vi.unstubAllGlobals() })

describe('standalone browser assembly', () => {
  it('routes scoped interactions through the existing caller and disposes transport activity', async () => {
    const scopesReady = Promise.withResolvers<undefined>()
    const results: { args: { eventId: string; outcome: unknown } }[] = []
    let streamSignal: AbortSignal | undefined
    vi.stubGlobal('__DSH_TRANSPORT__', {
      async *openStream(_endpoint: string, _payload: unknown, signal: AbortSignal) {
        streamSignal = signal
        yield { type: 'ready', clientId: 'browser-client', host: { home: '' } }
        await new Promise<void>((resolve) => {
          void scopesReady.promise.then(resolve)
          if (signal.aborted) resolve()
          else signal.addEventListener('abort', () => { resolve() }, { once: true })
        })
        if (signal.aborted) return
        yield { type: 'waterfall', event: 'approval/request', eventId: 'missing', agentId: 'unknown-chat', request: { reason: 'unknown' } }
        yield { type: 'waterfall', event: 'approval/request', eventId: 'approval', agentId: 'own-chat', request: { reason: 'own approval' } }
        yield { type: 'waterfall', event: 'user-questions/request', eventId: 'question', agentId: 'own-chat', request: { questions: [] } }
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve()
          else signal.addEventListener('abort', () => { resolve() }, { once: true })
        })
      },
      fetch: (url: URL, init: RequestInit) => {
        const body = JSON.parse(init.body as string) as { rpcId: string; payload: (typeof results)[number] }
        if (url.pathname.endsWith('$events/result')) results.push(body.payload)
        return Promise.resolve(Response.json({ type: 'server-response', rpcId: body.rpcId, result: {
          ok: true, value: url.pathname.endsWith('applicationAgents') ? [{ id: 'support' }] : undefined,
        } }))
      },
    })
    const client = await createBrowserClient({ endpoint: 'https://application.example', credential: () => 'signed' })
    try {
      expect(await client.chats.applicationAgents()).toMatchObject({ ok: true, value: [{ id: 'support' }] })
      const approval = vi.fn(async () => 'allowed-once' as const)
      const question = vi.fn(async () => ({ answers: [] }))
      client.forChat('own-chat').$on('approval/request', approval)
      client.forChat('own-chat').$on('user-questions/request', question)
      scopesReady.resolve(undefined)
      await vi.waitFor(() => { expect(results).toHaveLength(3) })
      expect(approval).toHaveBeenCalledOnce()
      expect(question).toHaveBeenCalledOnce()
      expect(results.find(result => result.args.eventId === 'missing')?.args.outcome).toEqual({ kind: 'next' })
    } finally {
      scopesReady.resolve(undefined)
      await client.dispose()
    }
    expect(streamSignal?.aborted).toBe(true)
  })

  it('cleans up a failed assembly and accepts an explicit local method selection', async () => {
    await expect(createBrowserClient({ endpoint: 'file:///invalid', credential: () => 'token' })).rejects.toThrow('HTTP(S) server origin')
    const client = await createBrowserClient({ endpoint: 'http://127.0.0.1:1', credential: () => 'token', methods: ['applicationAgents'] })
    await client.dispose()
  })
})
