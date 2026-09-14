/** Credential rotation and redirect refusal through real loopback HTTP requests. */
import { createServer, type RequestListener } from 'node:http'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { JSONRPCRequestSchema, ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js'
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
    const handlers = new Set<Promise<void>>()
    onTestFinished(async () => { await Promise.allSettled(handlers) })
    const url = await endpoint((request, response) => {
      if (request.method !== 'POST') { response.writeHead(405).end(); return }
      const operation = (async () => {
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array))
        const parsed = JSONRPCRequestSchema.safeParse(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        if (!parsed.success) { response.writeHead(202).end(); return }
        const message = parsed.data
        if (message.method === 'tools/list') observed.push({ authorization: request.headers.authorization, staticHeader: request.headers['x-static'] })
        const result = message.method === 'initialize'
          ? { protocolVersion: message.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'credential-fixture', version: '1' } }
          : { tools: [] }
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
      })().catch((error: unknown) => { response.destroy(error instanceof Error ? error : new Error(String(error))) })
      handlers.add(operation)
      void operation.then(() => handlers.delete(operation))
    })
    let credential = 'Bearer first'
    const client = new Client({ name: 'credential-test', version: '1' }, { capabilities: {} })
    onTestFinished(async () => { await client.close() })
    await client.connect(createTransport(config(url), bridge(() => credential)))
    await client.request({ method: 'tools/list' }, ListToolsResultSchema)
    credential = 'Bearer rotated'
    await client.request({ method: 'tools/list' }, ListToolsResultSchema)
    expect(observed).toEqual([
      { authorization: 'Bearer first', staticHeader: 'retained' },
      { authorization: 'Bearer rotated', staticHeader: 'retained' },
    ])
  })

  it('refuses a credential-bearing redirect without contacting its target', async () => {
    let received = 0
    const target = await endpoint((_request, response) => { received += 1; response.writeHead(500).end() })
    const url = await endpoint((_request, response) => { response.writeHead(307, { location: target }).end() })
    const client = new Client({ name: 'redirect-test', version: '1' }, { capabilities: {} })
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
