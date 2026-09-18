/** Optional MCP hooks preserve ordinary wire calls and own custom catalog lifetimes. */
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { Client, InMemoryTransport, type Tool } from '@modelcontextprotocol/client'
import { Server } from '@modelcontextprotocol/server'
import { expect, it, onTestFinished, vi } from 'vitest'
import { startConnection, resolveReconnectPolicy, type Config } from '../src/index.ts'
import { syncTools, type ToolBridgeExtensions, type ToolDisposers } from '../src/tools.ts'

async function fixture() {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  let catalog: Tool[] = [{ name: 'read', inputSchema: { type: 'object' } }]
  const called = vi.fn()
  // oxlint-disable-next-line typescript/no-deprecated -- low-level handlers expose exact protocol parameters.
  const server = new Server({ name: 'hooks', version: '1' }, { capabilities: { tools: {} } })
  onTestFinished(async () => { await server.close() })
  server.setRequestHandler('tools/list', () => ({ tools: catalog }))
  server.setRequestHandler('tools/call', (request) => {
    called(request.params)
    return { content: [{ type: 'text', text: 'received' }] }
  })
  const [transport, peer] = InMemoryTransport.createLinkedPair()
  await server.connect(peer)
  let registered: ToolDisposers = new Map()
  onTestFinished(() => { for (const dispose of registered.values()) dispose() })
  async function connect() {
    const client = new Client({ name: 'hooks-client', version: '1' })
    onTestFinished(async () => { await client.close() })
    await client.connect(transport)
    return client
  }
  async function sync(client: Client, extensions?: ToolBridgeExtensions, strict = true) {
    registered = await syncTools(client, ctx, {
      serverName: 'hooks', toolCallTimeoutMs: 60_000, registrationFailure: strict ? 'throw' : 'contain',
      ...(extensions === undefined ? {} : { extensions }),
    }, registered)
  }
  const invoke = () => ctx.tools.execute({
    name: 'mcp__hooks__read', arguments: {}, callId: ToolCallId('hooks-call'), signal: new AbortController().signal,
  })
  return { ctx, called, transport, connect, sync, invoke, setCatalog(next: Tool[]) { catalog = next } }
}

it('omits metadata for ordinary MCP calls and sends current metadata when supplied', async () => {
  const f = await fixture()
  const client = await f.connect()
  await f.sync(client)
  expect((await f.invoke()).isError).toBe(false)
  expect(f.called).toHaveBeenLastCalledWith({ name: 'read', arguments: {} })
  const metadata = vi.fn(async () => ({ ticket: 'first' }))
  await f.sync(client, { metadata })
  await f.invoke()
  expect(f.called).toHaveBeenLastCalledWith({ name: 'read', arguments: {}, _meta: { ticket: 'first' } })
  metadata.mockResolvedValueOnce({ ticket: 'rotated' })
  await f.invoke()
  expect(f.called).toHaveBeenLastCalledWith({ name: 'read', arguments: {}, _meta: { ticket: 'rotated' } })
})

it('preserves the metadata hook receiver while reading invocation state', async () => {
  const f = await fixture()
  const client = await f.connect()
  const extensions = {
    ticket: 'first',
    async metadata() { return { ticket: this.ticket } },
  }
  await f.sync(client, extensions)
  extensions.ticket = 'rotated'
  expect((await f.invoke()).isError).toBe(false)
  expect(f.called).toHaveBeenLastCalledWith({ name: 'read', arguments: {}, _meta: { ticket: 'rotated' } })
})

it('rejects failed invocation authorization before the MCP server receives a call', async () => {
  const f = await fixture()
  const client = await f.connect()
  await f.sync(client, { metadata: async () => { throw new Error('ticket revoked') } })
  const result = await f.invoke()
  expect(result.isError).toBe(true)
  expect(result.error?.message).toContain('ticket revoked')
  expect(f.called).not.toHaveBeenCalled()
})

it('keeps the callable generation when preparation rejects a replacement catalog', async () => {
  const f = await fixture()
  const client = await f.connect()
  const prepare = vi.fn((definition: ToolDefinition, _tool: Readonly<Tool>) => ({ ...definition, description: 'Prepared description' }))
  await f.sync(client, { prepare })
  expect(f.ctx.tools.get('mcp__hooks__read')?.description).toBe('Prepared description')
  expect(prepare).toHaveBeenCalledWith(expect.objectContaining({ name: 'mcp__hooks__read' }), {
    name: 'read', inputSchema: { type: 'object' },
  })
  f.setCatalog([{ name: 'replacement', inputSchema: { type: 'object' } }])
  prepare.mockImplementationOnce(() => { throw new Error('schema refused') })
  await expect(f.sync(client, { prepare })).rejects.toThrow('schema refused')
  expect(f.ctx.tools.get('mcp__hooks__replacement')).toBeUndefined()
  expect((await f.invoke()).isError).toBe(false)
})

it.each([true, false])('rolls back custom registrations after a conflict with strict=%s', async (strict) => {
  const f = await fixture()
  const client = await f.connect()
  f.setCatalog([
    { name: 'first', inputSchema: { type: 'object' } },
    { name: 'conflict', inputSchema: { type: 'object' } },
  ])
  const catalog = new Map<string, ToolDefinition>()
  const unregister = vi.fn()
  const extensions: ToolBridgeExtensions = {
    register(definition) {
      if (definition.name.endsWith('conflict')) throw new Error('occupied namespace')
      catalog.set(definition.name, definition)
      return () => { catalog.delete(definition.name); unregister() }
    },
  }
  const syncing = f.sync(client, extensions, strict)
  if (strict) await expect(syncing).rejects.toThrow('occupied namespace')
  else await syncing
  expect(catalog.size).toBe(0)
  expect(unregister).toHaveBeenCalledOnce()
  expect(f.ctx.tools.get('mcp__hooks__first')).toBeUndefined()
})

it('uses a custom transport and releases its custom catalog when the connection disposes', async () => {
  const f = await fixture()
  const config: Config = {
    transport: 'streamable-http', url: 'https://unused.invalid/mcp', headers: {},
    serverName: 'hooks', toolCallTimeoutMs: 60_000, failOnStartupError: true,
  }
  const createTransport = vi.fn(() => f.transport)
  const catalog = new Map<string, ToolDefinition>()
  const connection = startConnection(f.ctx, config, resolveReconnectPolicy({ enabled: false }, 'test'), {
    createTransport,
    tools: {
      register(definition) {
        catalog.set(definition.name, definition)
        return () => { catalog.delete(definition.name) }
      },
    },
  })
  onTestFinished(async () => { await connection.dispose() })
  expect(await connection.ready).toEqual({})
  expect(createTransport).toHaveBeenCalledOnce()
  expect(catalog.has('mcp__hooks__read')).toBe(true)
  expect(f.ctx.tools.get('mcp__hooks__read')).toBeUndefined()
  await connection.dispose()
  expect(catalog.size).toBe(0)
})

it('reports a custom registration conflict as failed strict startup', async () => {
  const f = await fixture()
  const connection = startConnection(f.ctx, {
    transport: 'streamable-http', url: 'https://unused.invalid/mcp', headers: {},
    serverName: 'hooks', toolCallTimeoutMs: 60_000, failOnStartupError: true,
  }, resolveReconnectPolicy({ enabled: false }, 'test'), {
    createTransport: () => f.transport,
    tools: { register() { throw new Error('custom catalog occupied') } },
  })
  onTestFinished(async () => { await connection.dispose() })
  const outcome = await connection.ready
  expect(outcome.error).toBeInstanceOf(Error)
  expect((outcome.error as Error).message).toBe('custom catalog occupied')
})
