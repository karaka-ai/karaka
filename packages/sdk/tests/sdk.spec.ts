import {
  createKarakaClient,
  type ChatResult,
  type KarakaConnection,
} from '@karaka/sdk'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it, vi } from 'vitest'

describe('Karaka SDK', () => {
  it('sends new and resumed chats with invocation-scoped credentials', async () => {
    const requests: Array<{ url: string, authorization: string | undefined, tenant: string | undefined, body: unknown }> = []
    const server = await openServer(async (request, response) => {
      requests.push({
        url: request.url ?? '',
        authorization: request.headers.authorization,
        tenant: textHeader(request.headers['x-karaka-tenant']),
        body: await readBody(request),
      })
      writeJson(response, chatResult('chat/one', requests.length === 1 ? 'Hello' : 'Again'))
    })
    const credentials = vi.fn(async () => ({ tenantId: 'acme', token: 'default-user' }))
    const client = createKarakaClient({ endpoint: `${server.endpoint}/v1`, credentials })

    try {
      const started = await client.chat.send({ agentId: 'support', message: 'Hello' })
      const resumed = await client.chat.send(
        { chatId: started.chatId, message: 'Again' },
        { credentials: { tenantId: 'beta', token: 'override-user' } },
      )

      expect(resumed.chatId).toBe('chat/one')
      expect(credentials).toHaveBeenCalledTimes(1)
      expect(requests).toEqual([
        {
          url: '/v1/chats',
          authorization: 'Bearer default-user',
          tenant: 'acme',
          body: { agentId: 'support', message: 'Hello' },
        },
        {
          url: '/v1/chats/chat%2Fone/messages',
          authorization: 'Bearer override-user',
          tenant: 'beta',
          body: { message: 'Again' },
        },
      ])
    } finally {
      await server.close()
    }
  })

  it('parses incremental SSE events across arbitrary response chunks', async () => {
    const server = await openServer(async (_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      response.write('event: text-delta\nda')
      await Promise.resolve()
      response.write('ta: {"type":"text-delta","delta":"Received: "}\n\n')
      response.write('event: text-delta\ndata: {"type":"text-delta","delta":"Hello"}\r\n\r\n')
      response.end(`event: completed\ndata: ${JSON.stringify({ type: 'completed', result: chatResult('chat-1', 'Hello') })}\n\n`)
    })
    const client = createKarakaClient({
      endpoint: `${server.endpoint}/v1`,
      credentials: { tenantId: 'acme', token: 'user-a' },
    })

    try {
      const events = []
      for await (const event of client.chat.stream({ agentId: 'support', message: 'Hello' })) events.push(event)
      expect(events).toEqual([
        { type: 'text-delta', delta: 'Received: ' },
        { type: 'text-delta', delta: 'Hello' },
        { type: 'completed', result: chatResult('chat-1', 'Hello') },
      ])
    } finally {
      await server.close()
    }
  })

  it('turns server failures and cancellation into typed client errors', async () => {
    let releaseRequest: (() => void) | undefined
    const requestStarted = new Promise<void>(resolve => {
      releaseRequest = resolve
    })
    let pending = false
    const server = await openServer((_request, response) => {
      if (!pending) {
        pending = true
        writeJson(response, { error: { code: 'CHAT_NOT_FOUND', message: 'chat is not available' } }, 404)
        return
      }
      releaseRequest?.()
    })
    const client = createKarakaClient({
      endpoint: `${server.endpoint}/v1`,
      credentials: { tenantId: 'acme', token: 'user-a' },
    })

    try {
      await expect(client.chat.send({ chatId: 'missing', message: 'Again' })).rejects.toMatchObject({
        name: 'KarakaClientError',
        code: 'CHAT_NOT_FOUND',
        status: 404,
      })

      const controller = new AbortController()
      const call = client.chat.send({ agentId: 'support', message: 'Wait' }, { signal: controller.signal })
      await requestStarted
      controller.abort()
      await expect(call).rejects.toEqual(expect.objectContaining({ name: 'KarakaClientError', code: 'ABORTED' }))
    } finally {
      await server.close()
    }
  })

  it('supports an advanced connection without changing the chat facade', async () => {
    const result = chatResult('local-chat', 'Local')
    const send = vi.fn<KarakaConnection['send']>(async () => result)
    const connection: KarakaConnection = {
      send,
      async *stream() {
        yield { type: 'completed', result }
      },
    }
    const client = createKarakaClient({
      connection,
      credentials: { tenantId: 'local', token: 'trusted-host' },
    })

    await expect(client.chat.send({ agentId: 'support', message: 'Local' })).resolves.toEqual(result)
    expect(send).toHaveBeenCalledWith(
      { agentId: 'support', message: 'Local' },
      { credentials: { tenantId: 'local', token: 'trusted-host' } },
    )
  })

  it('rejects invalid configuration and responses before exposing them', async () => {
    expect(() => createKarakaClient({
      endpoint: 'file:///tmp/karaka.sock',
      credentials: { tenantId: 'acme', token: 'user-a' },
    })).toThrow('must use HTTP or HTTPS')

    const server = await openServer((_request, response) => {
      writeJson(response, { chatId: 'chat-1', agentId: 'support', model: 'test', message: { role: 'user', content: 'bad' } })
    })
    const client = createKarakaClient({ endpoint: `${server.endpoint}/v1` })
    try {
      await expect(client.chat.send(
        { agentId: 'support', message: 'Hello' },
        { credentials: async () => ({ tenantId: 'acme', token: 'user-a' }) },
      )).rejects.toEqual(expect.objectContaining({ code: 'INVALID_RESPONSE' }))
    } finally {
      await server.close()
    }
  })
})

function chatResult(chatId: string, message: string): ChatResult {
  return {
    chatId,
    agentId: 'support',
    model: 'support-model',
    message: { role: 'assistant', content: `Received: ${message}` },
  }
}

async function openServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>,
) {
  const server = createServer((request, response) => {
    void Promise.resolve(handler(request, response)).catch(error => {
      response.destroy(error as Error)
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = (server.address() as AddressInfo).port
  return {
    endpoint: `http://127.0.0.1:${port}`,
    async close() {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve())
      })
    },
  }
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}

function writeJson(response: ServerResponse, value: unknown, status = 200) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(value))
}

function textHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined
}
