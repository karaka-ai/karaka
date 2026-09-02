import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createKarakaClient } from '@karaka-ai/sdk'

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
        controller.enqueue(encoder.encode('event: message\r\ndata: {"type":"text-delta",\r\ndata: "cursor":2,"text":"two"}\r'))
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

  it('supports every identity-bound chat operation and generated id', async () => {
    const calls: Array<{ readonly url: string; readonly init: RequestInit | undefined }> = []
    const fetch = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString()
      calls.push({ url, init })
      const response = url.endsWith('/chats')
        ? { chatId: 'generated-chat', agentId: 'support' }
        : url.endsWith('/messages')
          ? { chatId: 'chat/1', requestId: 'generated-request', accepted: true, duplicate: false }
          : url.endsWith('/model')
            ? { selected: { provider: 'deepseek', model: 'chat' } }
            : { accepted: true }
      return Promise.resolve(Response.json(response))
    })
    const chats = createKarakaClient({ endpoint: 'http://karaka', chatToken: 'token', fetch })
      .forUser({ tenantId: 'tenant', userId: 'user' }).chats

    await expect(chats.create({ agentId: 'support' })).resolves.toEqual({
      chatId: 'generated-chat', agentId: 'support',
    })
    await expect(chats.send({
      chatId: 'chat/1',
      content: [{ type: 'image', mediaType: 'image/png', data: 'encoded' }],
    })).resolves.toMatchObject({ accepted: true })
    await expect(chats.cancel('chat/1')).resolves.toEqual({ accepted: true })
    await expect(chats.setModel('chat/1', { provider: 'deepseek', model: 'chat' })).resolves.toEqual({
      selected: { provider: 'deepseek', model: 'chat' },
    })
    await expect(chats.respond({
      chatId: 'chat/1', interactionId: 'interaction', answers: { answers: [] },
    })).resolves.toEqual({ accepted: true })

    expect(calls.map(call => call.url)).toEqual([
      'http://karaka/v1/chats',
      'http://karaka/v1/chats/chat%2F1/messages',
      'http://karaka/v1/chats/chat%2F1/cancel',
      'http://karaka/v1/chats/chat%2F1/model',
      'http://karaka/v1/chats/chat%2F1/responses',
    ])
    const createPayload = calls[0]?.init?.body
    const sendPayload = calls[1]?.init?.body
    if (typeof createPayload !== 'string' || typeof sendPayload !== 'string') throw new Error('expected JSON bodies')
    const createBody = JSON.parse(createPayload) as { chatId: string }
    const sendBody = JSON.parse(sendPayload) as { requestId: string; content: unknown }
    expect(createBody.chatId).toMatch(/^[\da-f-]{36}$/u)
    expect(sendBody.requestId).toMatch(/^[\da-f-]{36}$/u)
    expect(sendBody.content).toEqual([{ type: 'image', mediaType: 'image/png', data: 'encoded' }])
  })

  it('preserves caller headers and validates client configuration and identity', async () => {
    const fetch = vi.fn((_input: string | URL | Request, _init?: RequestInit) => Promise.resolve(Response.json([])))
    const client = createKarakaClient({ endpoint: 'http://karaka', chatToken: 'token', fetch })

    await client.request('/agents', {
      method: 'POST',
      body: '{}',
      headers: { 'content-type': 'application/vendor+json' },
    }, z.array(z.unknown()))
    const headers = new Headers(fetch.mock.calls[0]?.[1]?.headers)
    expect(headers.get('content-type')).toBe('application/vendor+json')
    await client.request('/agents', { method: 'GET', signal: new AbortController().signal }, z.array(z.unknown()))
    expect(() => client.forUser({ tenantId: '', userId: 'user' })).toThrow()
    expect(() => createKarakaClient({ endpoint: 'http://karaka', path: 'v1', chatToken: 'token' })).toThrow(/path/u)
    expect(() => createKarakaClient({ endpoint: 'http://karaka', path: '/', chatToken: 'token' })).toThrow(/path/u)
    expect(() => createKarakaClient({ endpoint: 'http://karaka', chatToken: 'token' })).not.toThrow()
  })

  it('reports structured and proxy HTTP failures', async () => {
    const structured = createKarakaClient({
      endpoint: 'http://karaka',
      chatToken: 'token',
      fetch: () => Promise.resolve(Response.json({ code: 'denied', message: 'No access' }, { status: 403 })),
    })
    const structuredError = await structured.agents.list().catch((error: unknown) => error)
    expect(structuredError).toMatchObject({ message: 'No access', code: 'denied' })

    const proxy = createKarakaClient({
      endpoint: 'http://karaka',
      chatToken: 'token',
      fetch: () => Promise.resolve(new Response('upstream unavailable', { status: 502 })),
    })
    await expect(proxy.agents.list()).rejects.toThrow('Karaka request failed with HTTP 502')

    const unstructured = createKarakaClient({
      endpoint: 'http://karaka',
      chatToken: 'token',
      fetch: () => Promise.resolve(Response.json({ code: 1, message: null }, { status: 500 })),
    })
    await expect(unstructured.agents.list()).rejects.toMatchObject({
      message: 'Karaka request failed with HTTP 500',
    })
  })

  it('rejects empty and cancelled credentials before dispatch', async () => {
    const fetch = vi.fn()
    const empty = createKarakaClient({ endpoint: 'http://karaka', chatToken: '', fetch })
    await expect(empty.agents.list()).rejects.toThrow(/must not be empty/u)
    const emptyController = new AbortController()
    await expect(empty.forUser({ tenantId: 'tenant', userId: 'user' }).chats.stream({
      chatId: 'chat', signal: emptyController.signal,
    })[Symbol.asyncIterator]().next()).rejects.toThrow(/must not be empty/u)

    const controller = new AbortController()
    controller.abort('stop')
    const cancelled = createKarakaClient({ endpoint: 'http://karaka', chatToken: 'token', fetch })
    const next = cancelled.forUser({ tenantId: 'tenant', userId: 'user' }).chats.stream({
      chatId: 'chat', signal: controller.signal,
    })[Symbol.asyncIterator]().next()
    await expect(next).rejects.toBe('stop')

    const started = Promise.withResolvers<undefined>()
    const pending = createKarakaClient({
      endpoint: 'http://karaka',
      chatToken: () => {
        started.resolve(undefined)
        return new Promise(() => undefined)
      },
      fetch,
    })
    const laterController = new AbortController()
    const pendingNext = pending.forUser({ tenantId: 'tenant', userId: 'user' }).chats.stream({
      chatId: 'chat', signal: laterController.signal,
    })[Symbol.asyncIterator]().next()
    await started.promise
    laterController.abort('stop')
    await expect(pendingNext).rejects.toThrow('Karaka request cancelled')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('rejects failed or bodyless streams and propagates server error events', async () => {
    const failed = createKarakaClient({
      endpoint: 'http://karaka',
      chatToken: 'token',
      fetch: () => Promise.resolve(Response.json({ message: 'stream denied' }, { status: 403 })),
    })
    await expect(failed.forUser({ tenantId: 't', userId: 'u' }).chats.stream({ chatId: 'c' })
      [Symbol.asyncIterator]().next()).rejects.toThrow('stream denied')

    const bodyless = createKarakaClient({
      endpoint: 'http://karaka', chatToken: 'token', fetch: () => Promise.resolve(new Response(null)),
    })
    await expect(bodyless.forUser({ tenantId: 't', userId: 'u' }).chats.stream({ chatId: 'c' })
      [Symbol.asyncIterator]().next()).rejects.toThrow(/no body/u)

    const encoder = new TextEncoder()
    const errorStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(': keepalive\n\ndata: {"type":"error","code":"failed","message":"turn failed"}\n\n'))
        controller.close()
      },
    })
    const errored = createKarakaClient({
      endpoint: 'http://karaka', chatToken: 'token', fetch: () => Promise.resolve(new Response(errorStream)),
    })
    await expect(errored.forUser({ tenantId: 't', userId: 'u' }).chats.stream({ chatId: 'c' })
      [Symbol.asyncIterator]().next()).rejects.toMatchObject({ message: 'turn failed', code: 'failed' })
  })

  it('handles terminal SSE lines and a failed consumer cancellation', async () => {
    const encoder = new TextEncoder()
    const cancel = vi.fn(() => Promise.reject(new Error('transport already closed')))
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"type":"text-delta","cursor":1,"text":"one"}\n\n'))
      },
      cancel,
    })
    const client = createKarakaClient({
      endpoint: 'http://karaka', chatToken: 'token', fetch: () => Promise.resolve(new Response(stream)),
    })

    for await (const _event of client.forUser({ tenantId: 't', userId: 'u' }).chats.stream({ chatId: 'c' })) break

    expect(cancel).toHaveBeenCalledOnce()

    const terminal = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(': terminal line without delimiter\r'))
        controller.close()
      },
    })
    const terminalClient = createKarakaClient({
      endpoint: 'http://karaka', chatToken: 'token', fetch: () => Promise.resolve(new Response(terminal)),
    })
    const events = []
    for await (const event of terminalClient.forUser({ tenantId: 't', userId: 'u' }).chats.stream({ chatId: 'c' })) {
      events.push(event)
    }
    expect(events).toEqual([])

    const unterminated = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(': terminal line without delimiter'))
        controller.close()
      },
    })
    const unterminatedClient = createKarakaClient({
      endpoint: 'http://karaka', chatToken: 'token', fetch: () => Promise.resolve(new Response(unterminated)),
    })
    for await (const _event of unterminatedClient.forUser({ tenantId: 't', userId: 'u' }).chats.stream({ chatId: 'c' })) {
      throw new Error('comment-only stream yielded an event')
    }

    const signalled = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close()
      },
    })
    const signal = new AbortController().signal
    const fetch = vi.fn(() => Promise.resolve(new Response(signalled)))
    const signalledClient = createKarakaClient({ endpoint: 'http://karaka', chatToken: 'token', fetch })
    for await (const _event of signalledClient.forUser({ tenantId: 't', userId: 'u' }).chats.stream({
      chatId: 'c', signal,
    })) {
      throw new Error('empty stream yielded an event')
    }
    expect(fetch).toHaveBeenCalledWith('http://karaka/v1/chats/c/stream', expect.objectContaining({ signal }))
  })
})
