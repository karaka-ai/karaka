/** Credential rotation and redirect refusal through real loopback HTTP requests. */
import { createServer, type RequestListener } from 'node:http'
import { Client } from '@modelcontextprotocol/client'
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server'
import { toNodeHandler, type NodeIncomingMessageLike } from '@modelcontextprotocol/node'
import { describe, expect, it, onTestFinished } from 'vitest'
import type { ApplicationBridge, Config } from '../src/index.ts'
import { createTransport } from '../src/transport.ts'

async function endpoint(handler: RequestListener) {
  const server = createServer(handler)
  onTestFinished(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => { if (error === undefined) resolve(); else reject(error) })
      server.closeAllConnections()
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('HTTP fixture did not bind a TCP port')
  return `http://127.0.0.1:${address.port}/mcp`
}

function config(url: string): Config {
  return {
    applicationId: 'app', serverName: 'app', url,
    headers: { authorization: 'Bearer stale', 'x-static': 'retained' },
    toolCallTimeoutMs: 60_000, failOnStartupError: true, allow: [], deny: [],
  }
}

function bridge(credential: () => string): ApplicationBridge {
  return {
    headers: async () => ({ authorization: credential() }),
    metadata: async () => ({}),
    register: () => () => {},
  }
}

describe('application MCP HTTP transport', () => {
  it('resolves credentials for each request and overrides stale static authorization', async () => {
    const observed: { authorization: string | undefined; staticHeader: string | string[] | undefined }[] = []
    const handler = createMcpHandler((context) => {
      const mcp = new McpServer({ name: 'credential-fixture', version: '1' }, { capabilities: { tools: {} } })
      mcp.server.setRequestHandler('tools/list', async () => {
        const headers = context.requestInfo?.headers
        if (headers === undefined) throw new Error('HTTP fixture requires its request headers')
        observed.push({ authorization: headers.get('authorization') ?? undefined, staticHeader: headers.get('x-static') ?? undefined })
        return { tools: [] }
      })
      return mcp
    })
    onTestFinished(async () => { await handler.close() })
    const handle = toNodeHandler(handler)
    const handlers = new Set<Promise<void>>()
    onTestFinished(async () => { await Promise.allSettled(handlers) })
    const url = await endpoint((request, response) => {
      // Match the SDK's exact optional Node HTTP fields at its public adapter.
      const operation = handle(request as NodeIncomingMessageLike, response)
        .catch((error: unknown) => { response.destroy(error instanceof Error ? error : new Error(String(error))) })
      handlers.add(operation)
      void operation.then(() => handlers.delete(operation))
    })
    let credential = 'Bearer first'
    const client = new Client({ name: 'credential-test', version: '1' }, { capabilities: {}, versionNegotiation: { mode: 'auto' } })
    onTestFinished(async () => { await client.close() })
    await client.connect(createTransport(config(url), bridge(() => credential)))
    await client.listTools(undefined, { cacheMode: 'refresh' })
    credential = 'Bearer rotated'
    await client.listTools(undefined, { cacheMode: 'refresh' })
    expect(observed).toEqual([
      { authorization: 'Bearer first', staticHeader: 'retained' },
      { authorization: 'Bearer rotated', staticHeader: 'retained' },
    ])
  })

  it('refuses a credential-bearing redirect without contacting its target', async () => {
    let received = 0
    const target = await endpoint((_request, response) => { received += 1; response.writeHead(500).end() })
    const url = await endpoint((_request, response) => { response.writeHead(307, { location: target }).end() })
    const client = new Client({ name: 'redirect-test', version: '1' }, { capabilities: {}, versionNegotiation: { mode: 'auto' } })
    onTestFinished(async () => { await client.close() })
    await expect(client.connect(createTransport(config(url), bridge(() => 'Bearer private')))).rejects.toThrow()
    expect(received).toBe(0)
  })

  it.each(['file:///tmp/mcp', 'ftp://example.test/mcp'])('rejects non-HTTP endpoint %s before requesting credentials', (url) => {
    let requested = false
    expect(() => createTransport(config(url), bridge(() => { requested = true; return 'private' }))).toThrow('HTTP or HTTPS')
    expect(requested).toBe(false)
  })
})
