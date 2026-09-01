import { describe, expect, it, vi } from 'vitest'
import { createKarakaClient } from '@karaka/sdk'

describe('KarakaClient', () => {
  it('authenticates requests and binds tenant/user identity', async () => {
    let requestInit: RequestInit | undefined
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      requestInit = init
      return new Response(JSON.stringify({
        chatId: 'chat-1',
        requestId: 'request-1',
        accepted: true,
        duplicate: false,
      }), { status: 202, headers: { 'content-type': 'application/json' } })
    })
    const karaka = createKarakaClient({
      endpoint: 'https://karaka.internal/',
      chatToken: () => Promise.resolve('chat-secret'),
      fetch,
    })

    const receipt = await karaka.forUser({ tenantId: 'tenant-1', userId: 'user-1' }).chats.send({
      chatId: 'chat-1',
      requestId: 'request-1',
      content: 'Help me',
    })

    expect(receipt.duplicate).toBe(false)
    expect(fetch).toHaveBeenCalledWith('https://karaka.internal/v1/chats/chat-1/messages', expect.objectContaining({
      body: JSON.stringify({
        tenantId: 'tenant-1',
        userId: 'user-1',
        requestId: 'request-1',
        content: [{ type: 'text', text: 'Help me' }],
      }),
    }))
    const headers = new Headers(requestInit?.headers)
    expect(headers.get('authorization')).toBe('Bearer chat-secret')
  })

  it('validates server responses and streamed event frames', async () => {
    const invalidFetch = vi.fn(() => Promise.resolve(new Response('{}', { status: 200 })))
    const invalid = createKarakaClient({ endpoint: 'http://karaka', chatToken: 'token', fetch: invalidFetch })
    await expect(invalid.agents.list()).rejects.toThrow()

    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"type":"text-delta","cursor":1,'))
        controller.enqueue(encoder.encode('"text":"hello"}\n\n'))
        controller.close()
      },
    })
    const streamFetch = vi.fn(() => Promise.resolve(new Response(stream, { status: 200 })))
    const client = createKarakaClient({ endpoint: 'http://karaka', chatToken: 'token', fetch: streamFetch })
    const events = []
    for await (const event of client.forUser({ tenantId: 't', userId: 'u' }).chats.stream({ chatId: 'c' })) {
      events.push(event)
    }
    expect(events).toEqual([{ type: 'text-delta', cursor: 1, text: 'hello' }])
  })

  it('validates user messages in history and SSE order', async () => {
    const user = {
      type: 'user-message' as const,
      cursor: 1,
      content: {
        id: 'user-1',
        role: 'user',
        content: [{ type: 'text', text: 'Help me' }],
        source: { kind: 'user', rpcId: 'request-1' },
      },
    }
    const assistant = {
      type: 'assistant-message' as const,
      cursor: 2,
      content: { id: 'assistant-1', role: 'assistant', content: [{ type: 'text', text: 'Sure' }] },
    }
    const encoder = new TextEncoder()
    const fetch = vi.fn((input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input
      if (url.endsWith('/history')) {
        return Promise.resolve(new Response(JSON.stringify({ chatId: 'chat-1', events: [user, assistant] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }))
      }
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(user)}\n\n`))
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(assistant)}\n\n`))
          controller.close()
        },
      })
      return Promise.resolve(new Response(stream, { status: 200 }))
    })
    const client = createKarakaClient({ endpoint: 'http://karaka', chatToken: 'token', fetch })
    const chats = client.forUser({ tenantId: 'tenant-1', userId: 'user-1' }).chats

    await expect(chats.history('chat-1')).resolves.toEqual({ chatId: 'chat-1', events: [user, assistant] })
    const streamed = []
    for await (const event of chats.stream({ chatId: 'chat-1' })) streamed.push(event)
    expect(streamed).toEqual([user, assistant])
  })

  it('parses CRLF event frames split between transport chunks', async () => {
    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"type":"text-delta","cursor":1,"text":"one"}\r\n\r\n'))
        controller.enqueue(encoder.encode('data: {"type":"text-delta","cursor":2,"text":"two"}\r'))
        controller.enqueue(encoder.encode('\n\r\n'))
        controller.close()
      },
    })
    const fetch = vi.fn(() => Promise.resolve(new Response(stream, { status: 200 })))
    const client = createKarakaClient({ endpoint: 'http://karaka', chatToken: 'token', fetch })
    const events = []

    for await (const event of client.forUser({ tenantId: 't', userId: 'u' }).chats.stream({ chatId: 'c' })) {
      events.push(event)
    }

    expect(events).toEqual([
      { type: 'text-delta', cursor: 1, text: 'one' },
      { type: 'text-delta', cursor: 2, text: 'two' },
    ])
  })

  it('coordinates a custom server transport path explicitly', async () => {
    const fetch = vi.fn(() => Promise.resolve(new Response(JSON.stringify([]), { status: 200 })))
    const client = createKarakaClient({
      endpoint: 'http://karaka/',
      path: '/agent-api',
      chatToken: 'token',
      fetch,
    })

    await client.agents.list()
    expect(fetch).toHaveBeenCalledWith('http://karaka/agent-api/agents', expect.anything())
    expect(() => createKarakaClient({ endpoint: 'http://karaka', path: '/bad/', chatToken: 'token' }))
      .toThrow(/path/)
  })

  it('cancels the response body when a stream consumer stops early', async () => {
    const encoder = new TextEncoder()
    const cancel = vi.fn()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"type":"text-delta","cursor":1,"text":"hello"}\n\n'))
      },
      cancel,
    })
    const fetch = vi.fn(() => Promise.resolve(new Response(stream, { status: 200 })))
    const client = createKarakaClient({ endpoint: 'http://karaka', chatToken: 'token', fetch })

    for await (const _event of client.forUser({ tenantId: 't', userId: 'u' }).chats.stream({ chatId: 'c' })) break

    expect(cancel).toHaveBeenCalledOnce()
  })

  it('cancels chat credential resolution before starting a stream request', async () => {
    const started = Promise.withResolvers<undefined>()
    const fetch = vi.fn()
    const client = createKarakaClient({
      endpoint: 'http://karaka',
      chatToken: signal => new Promise((_resolve, reject) => {
        started.resolve(undefined)
        signal?.addEventListener('abort', () => {
          reject(signal.reason instanceof Error ? signal.reason : new Error('credential resolution cancelled'))
        }, { once: true })
      }),
      fetch,
    })
    const abort = new AbortController()
    const next = client.forUser({ tenantId: 't', userId: 'u' }).chats.stream({
      chatId: 'c', signal: abort.signal,
    })[Symbol.asyncIterator]().next()
    await started.promise
    abort.abort(new Error('cancelled'))

    await expect(next).rejects.toThrow('cancelled')
    expect(fetch).not.toHaveBeenCalled()
  })
})
