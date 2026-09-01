import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createKarakaToolHost } from '@karaka/sdk'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map(cleanup => cleanup()))
})

describe('KarakaToolHost', () => {
  it.each(['express', 'next'] as const)(
    'accepts framework-preparsed MCP bodies through the %s adapter',
    async (adapter) => {
      const callback = vi.fn(() => ({ content: [{ type: 'text' as const, text: adapter }] }))
      const host = createKarakaToolHost({ verifyToken: 'tool-secret' })
      host.registerTool('echo', { inputSchema: z.object({ value: z.string() }) }, callback)
      const handler = adapter === 'express' ? host.expressHandler() : host.nextHandler()
      const server = createServer((request, response) => {
        void (async () => {
          const chunks: Buffer[] = []
          for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array))
          const raw = Buffer.concat(chunks).toString('utf8')
          if (raw.length > 0) Object.assign(request, { body: JSON.parse(raw) as unknown })
          await handler(request, response)
        })()
      })
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', resolve)
      })
      const address = server.address() as AddressInfo
      const client = new Client({ name: `karaka-${adapter}-test`, version: '1.0.0' })
      cleanups.push(async () => {
        try { await client.close() } catch { /* client may already be closed */ }
        await host.close()
        server.closeAllConnections()
        await new Promise<void>(resolve => server.close(() => { resolve() }))
      })
      await client.connect(new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${String(address.port)}`),
        { requestInit: { headers: { authorization: 'Bearer tool-secret' } } },
      ) as unknown as Parameters<Client['connect']>[0])

      await expect(client.listTools()).resolves.toMatchObject({ tools: [{ name: 'echo' }] })
      await expect(client.callTool({
        name: 'echo',
        arguments: { value: 'hello' },
        _meta: {
          karaka: { applicationId: 'billing', tenantId: 'tenant-1', userId: 'user-1', chatId: 'chat-1' },
        },
      })).resolves.toMatchObject({ content: [{ type: 'text', text: adapter }] })
      expect(callback).toHaveBeenCalledOnce()
    },
  )

  it('serves registered functions over authenticated MCP with trusted identity', async () => {
    const callback = vi.fn(() => ({ content: [{ type: 'text' as const, text: 'refunded' }] }))
    const host = createKarakaToolHost({ verifyToken: 'tool-secret' })
    host.registerTool('invoices_refund', {
      description: 'Refund an invoice',
      inputSchema: z.object({ invoiceId: z.string() }).strict(),
    }, callback)
    expect(() => host.registerTool('invoices_refund', {
      inputSchema: z.object({}),
    }, callback)).toThrow(/already registered/)

    const handler = host.expressHandler()
    const server = createServer((request, response) => {
      void handler(request, response)
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address() as AddressInfo
    const client = new Client({ name: 'karaka-sdk-test', version: '1.0.0' })
    cleanups.push(async () => {
      try { await client.close() } catch { /* client may already be closed */ }
      await host.close()
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => { resolve() }))
    })
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${String(address.port)}`),
      { requestInit: { headers: { authorization: 'Bearer tool-secret' } } },
    )
    await client.connect(transport as unknown as Parameters<Client['connect']>[0])

    const tools = await client.listTools()
    expect(tools.tools.map(tool => tool.name)).toEqual(['invoices_refund'])
    const result = await client.callTool({
      name: 'invoices_refund',
      arguments: { invoiceId: 'inv-1' },
      _meta: {
        karaka: { applicationId: 'billing', tenantId: 'tenant-1', userId: 'user-1', chatId: 'chat-1' },
      },
    })

    expect(result.content).toEqual([{ type: 'text', text: 'refunded' }])
    expect(callback).toHaveBeenCalledWith(
      { invoiceId: 'inv-1' },
      expect.objectContaining({
        applicationId: 'billing', tenantId: 'tenant-1', userId: 'user-1', chatId: 'chat-1',
      }),
    )
  })

  it('rejects an invalid server token before MCP dispatch', async () => {
    const host = createKarakaToolHost({ verifyToken: 'expected' })
    const handler = host.expressHandler()
    const server = createServer((request, response) => {
      void handler(request, response)
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address() as AddressInfo
    cleanups.push(async () => {
      await host.close()
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => { resolve() }))
    })

    const response = await fetch(`http://127.0.0.1:${String(address.port)}`, {
      method: 'POST',
      headers: { authorization: 'Bearer wrong', 'content-type': 'application/json' },
      body: '{}',
    })
    expect(response.status).toBe(401)
  })

  it('cancels admitted authentication when the host closes', async () => {
    const started = Promise.withResolvers<undefined>()
    let resolverSignal: AbortSignal | undefined
    const host = createKarakaToolHost({
      verifyToken: (signal) => {
        resolverSignal = signal
        started.resolve(undefined)
        return new Promise(() => undefined)
      },
    })
    const handler = host.expressHandler()
    const server = createServer((request, response) => { void handler(request, response) })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address() as AddressInfo
    cleanups.push(async () => {
      await host.close()
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => { resolve() }))
    })
    const request = fetch(`http://127.0.0.1:${String(address.port)}`, {
      method: 'POST',
      headers: { authorization: 'Bearer expected', 'content-type': 'application/json' },
      body: '{}',
    })
    await started.promise
    await expect(host.close()).resolves.toBeUndefined()
    expect(resolverSignal?.aborted).toBe(true)
    await expect(request).resolves.toMatchObject({ status: 503 })
  })

  it('rejects requests admitted after the host closes', async () => {
    const verifyToken = vi.fn(() => new Promise<string>(() => undefined))
    const host = createKarakaToolHost({ verifyToken })
    await host.close()
    const handler = host.expressHandler()
    const server = createServer((request, response) => { void handler(request, response) })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address() as AddressInfo
    cleanups.push(async () => {
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => { resolve() }))
    })

    const response = await fetch(`http://127.0.0.1:${String(address.port)}`, {
      method: 'POST',
      headers: { authorization: 'Bearer expected', 'content-type': 'application/json' },
      body: '{}',
    })

    expect(response.status).toBe(503)
    expect(verifyToken).not.toHaveBeenCalled()
  })
})
