/** Exercise the application bridge through real MCP framing and DSH tool execution. */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { publicToolName, syncTools, type ToolBridgeOptions, type ToolDisposers } from '../src/tools.ts'

async function bridgeFixture() {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  let catalog: Tool[] = [{
    name: 'read.item',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'integer' } },
      required: ['id'],
      additionalProperties: false,
    },
  }]
  const called = vi.fn((params: unknown) => params)
  let remoteError = false
  // oxlint-disable-next-line typescript/no-deprecated -- low-level handlers exercise deliberately invalid catalog schemas.
  const server = new Server({ name: 'application-test', version: '1' }, { capabilities: { tools: {} } })
  onTestFinished(async () => { await server.close() })
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: catalog }))
  server.setRequestHandler(CallToolRequestSchema, (request) => {
    called(request.params)
    return { content: [{ type: 'text', text: remoteError ? 'application rejected the operation' : 'done' }], isError: remoteError }
  })
  const client = new Client({ name: 'application-test-client', version: '1' }, { capabilities: {} })
  onTestFinished(async () => { await client.close() })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  const metadata = vi.fn(async () => ({ karaka: { applicationId: 'app', tenantId: 'tenant', userId: 'user', chatId: 'chat' } }))
  const opts: ToolBridgeOptions = {
    serverName: 'app',
    toolCallTimeoutMs: 60_000,
    registrationFailure: 'throw',
    bridge: { headers: async () => ({}), metadata, register: definition => ctx.tools.register(definition) },
  }
  let registered: ToolDisposers = new Map()
  onTestFinished(() => { for (const dispose of registered.values()) dispose() })
  const sync = async () => { registered = await syncTools(client, ctx, opts, registered) }
  const invoke = (args: unknown, name = publicToolName('app', 'read.item')) => ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId('application-call'),
    name,
    arguments: args,
  })
  return {
    called, metadata, invoke, sync,
    setCatalog(next: Tool[]) { catalog = next },
    rejectRemotely() { remoteError = true },
    disposeCatalog() { for (const dispose of registered.values()) dispose(); registered.clear() },
  }
}

describe('application MCP dispatch', () => {
  it('rejects invalid local arguments before authorization or remote dispatch, then admits a correction', async () => {
    const fixture = await bridgeFixture()
    await fixture.sync()
    const rejected = await fixture.invoke({ id: 'wrong-type' })
    expect(rejected.isError).toBe(true)
    expect(rejected.error).toMatchObject({ info: { code: 'INVALID_ARGS' } })
    expect(fixture.metadata).not.toHaveBeenCalled()
    expect(fixture.called).not.toHaveBeenCalled()
    const accepted = await fixture.invoke({ id: 7 })
    expect(accepted.isError).toBe(false)
    expect(accepted.content).toEqual([{ type: 'text', text: 'done' }])
    expect(fixture.called).toHaveBeenCalledExactlyOnceWith({
      name: 'read.item', arguments: { id: 7 },
      _meta: { karaka: { applicationId: 'app', tenantId: 'tenant', userId: 'user', chatId: 'chat' } },
    })
  })

  it('rejects revoked invocation authority without calling the endpoint', async () => {
    const fixture = await bridgeFixture()
    await fixture.sync()
    fixture.metadata.mockRejectedValueOnce(new Error('Application tool is not allowed'))
    const rejected = await fixture.invoke({ id: 7 })
    expect(rejected.isError).toBe(true)
    expect(rejected.error?.message).toContain('Application tool is not allowed')
    expect(fixture.called).not.toHaveBeenCalled()
  })

  it('retains remote errors as executed failures, not local INVALID_ARGS', async () => {
    const fixture = await bridgeFixture()
    await fixture.sync()
    fixture.rejectRemotely()
    const rejected = await fixture.invoke({ id: 7 })
    expect(rejected.isError).toBe(true)
    expect(rejected.error?.message).toContain('application rejected the operation')
    expect(rejected.error?.info?.code).not.toBe('INVALID_ARGS')
    expect(fixture.called).toHaveBeenCalledTimes(1)
  })

  it('keeps the prior catalog when discovery repeats a tool name', async () => {
    const fixture = await bridgeFixture()
    await fixture.sync()
    fixture.setCatalog([
      { name: 'duplicate', inputSchema: { type: 'object' } },
      { name: 'duplicate', inputSchema: { type: 'object' } },
    ])
    await expect(fixture.sync()).rejects.toThrow('more than once')
    expect((await fixture.invoke({ id: 1 })).isError).toBe(false)
  })

  it('replaces a complete catalog and removes its registrations on disposal', async () => {
    const fixture = await bridgeFixture()
    await fixture.sync()
    fixture.setCatalog([{ name: 'replacement', inputSchema: { type: 'object' } }])
    await fixture.sync()
    expect((await fixture.invoke({ id: 1 })).error?.info?.code).toBe('UNKNOWN_TOOL')
    expect((await fixture.invoke({}, 'mcp__app__replacement')).isError).toBe(false)
    fixture.disposeCatalog()
    expect((await fixture.invoke({}, 'mcp__app__replacement')).error?.info?.code).toBe('UNKNOWN_TOOL')
  })

  it('rejects unsupported input schema vocabulary before replacing the active catalog', async () => {
    const fixture = await bridgeFixture()
    await fixture.sync()
    fixture.setCatalog([{ name: 'unsupported', inputSchema: { type: 'object', patternProperties: { '^x-': { type: 'string' } } } }])
    await expect(fixture.sync()).rejects.toThrow()
    expect((await fixture.invoke({ id: 1 })).isError).toBe(false)
  })
})
