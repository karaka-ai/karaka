/** Application catalog isolation through real Agent scopes, Tools and HTTP MCP framing. */
import { createServer } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry, type Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createScope } from '@deepseek-ai/dsh-scope'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { type ToolRunContext, type ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import { ApplicationId, KarakaIdentity, TenantId, UserId, type ApplicationOwner } from '@karaka-ai/identity'
import { ServerAuth } from '@karaka-ai/server-auth'
import type { Tool } from '@modelcontextprotocol/client'
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server'
import { toNodeHandler, type NodeIncomingMessageLike } from '@modelcontextprotocol/node'
import { describe, expect, it, onTestFinished } from 'vitest'
import { apply, inject, type Config } from '../src/index.ts'
import { applicationToolNames, registerPolicy } from '../src/policy.ts'

async function applicationFixture() {
  const root = new Context()
  onTestFinished(async () => { await root.fiber.dispose() })
  await root.plugin(SystemPrompt)
  await root.plugin(ToolRuntime)
  await root.plugin(AgentRegistry)
  const owners = new WeakMap<Session, ApplicationOwner>()
  // This fixture supplies trusted authority answers; identity persistence has its own suite.
  const identity = {
    ownerOfCached: (session: Session) => owners.get(session),
    ownerOf: async (session: Session) => owners.get(session),
  }
  root.provide('karakaIdentity', Object.setPrototypeOf(identity, KarakaIdentity.prototype) as KarakaIdentity)
  const serverAuth = { authorizeTools: async () => 'Bearer application' }
  root.provide('serverAuth', Object.setPrototypeOf(serverAuth, ServerAuth.prototype) as ServerAuth)
  const driver = root.plugin(Object.assign(() => {}, { inject }))
  await driver
  const requests: unknown[] = []
  let catalog: Tool[] = [{ name: 'read', inputSchema: { type: 'object' } }]
  const handler = createMcpHandler(() => {
    const mcp = new McpServer({ name: 'application-fixture', version: '1' }, { capabilities: { tools: {} } })
    mcp.server.setRequestHandler('tools/list', async () => ({ tools: catalog }))
    mcp.server.setRequestHandler('tools/call', async (request) => {
      requests.push(request.params)
      return { content: [{ type: 'text', text: 'accepted' }] }
    })
    return mcp
  })
  onTestFinished(async () => { await handler.close() })
  const handle = toNodeHandler(handler)
  const handlers = new Set<Promise<void>>()
  const server = createServer((request, response) => {
    // Match the SDK's exact optional Node HTTP fields at its public adapter.
    const operation = handle(request as NodeIncomingMessageLike, response)
      .catch((error: unknown) => { response.destroy(error instanceof Error ? error : new Error(String(error))) })
    handlers.add(operation)
    void operation.then(() => handlers.delete(operation))
  })
  onTestFinished(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => { if (error === undefined) resolve(); else reject(error) })
      server.closeAllConnections()
    })
    await Promise.allSettled(handlers)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('MCP fixture has no TCP address')
  const owner: ApplicationOwner = { applicationId: ApplicationId('app'), tenantId: TenantId('tenant'), userId: UserId('user') }
  const config: Config = {
    applicationId: owner.applicationId, serverName: 'app', url: `http://127.0.0.1:${address.port}/mcp`, headers: {},
    allow: ['mcp__app__read'], deny: [], toolCallTimeoutMs: 60_000, failOnStartupError: true, reconnect: { enabled: false },
  }
  function agent(id: string, claimed?: ApplicationOwner) {
    const session = Session.create(SessionId(id))
    if (claimed !== undefined) owners.set(session, claimed)
    // Registry and tool routing need only identity, context, Session and options; no loop runs.
    const value = { id: session.id, session, options: {} } as Agent
    const scope = createScope(driver.ctx, value)
    Object.assign(value, { ctx: scope.ctx })
    scope.ctx.effect(() => registerPolicy(scope.ctx, { allow: ['mcp__app__read'] }))
    const unregister = scope.ctx.agents.register(value)
    return { value, scope, unregister }
  }
  async function mount(overrides: Partial<Config> = {}) {
    const fiber = root.plugin(Object.assign(() => {}, { inject }))
    await fiber
    await apply(fiber.ctx, Object.assign({}, config, overrides))
    return fiber
  }
  const invoke = (agent?: Agent) => root.tools.execute({
    name: 'mcp__app__read', callId: ToolCallId('application-call'), arguments: {},
    signal: new AbortController().signal, ...(agent === undefined ? {} : { agent }),
  })
  return { root, owner, owners, requests, agent, mount, invoke, setCatalog(next: Tool[]) { catalog = next } }
}

describe('application MCP catalogs', () => {
  it('admits owned Agents before and after activation and denies foreign and agentless calls', async () => {
    const f = await applicationFixture()
    const first = f.agent('first', f.owner)
    const foreign = f.agent('foreign', { ...f.owner, applicationId: ApplicationId('other') })
    await f.mount()
    const second = f.agent('second', f.owner)
    expect((await f.invoke(first.value)).isError).toBe(false)
    expect((await f.invoke(second.value)).isError).toBe(false)
    expect((await f.invoke(foreign.value)).error?.info?.code).toBe('UNKNOWN_TOOL')
    expect((await f.invoke()).error?.info?.code).toBe('UNKNOWN_TOOL')
    expect(f.requests).toEqual([
      { name: 'read', arguments: {}, _meta: { karaka: { ...f.owner, chatId: 'first' } } },
      { name: 'read', arguments: {}, _meta: { karaka: { ...f.owner, chatId: 'second' } } },
    ])
  })

  it('reauthorizes cached registrations at dispatch and does not trust stale ownership', async () => {
    const f = await applicationFixture()
    const scoped = f.agent('owned', f.owner)
    await f.mount()
    f.owners.set(scoped.value.session, { ...f.owner, applicationId: ApplicationId('revoked') })
    const result = await f.invoke(scoped.value)
    expect(result.isError).toBe(true)
    expect(result.error?.message).toContain('owner does not match endpoint')
    expect(f.requests).toEqual([])
  })

  it('removes and restores scoped registrations as policy fibers unload', async () => {
    const f = await applicationFixture()
    const scoped = f.agent('owned', f.owner)
    const bridge = await f.mount()
    const denied = scoped.scope.ctx.plugin((ctx) => { ctx.effect(() => registerPolicy(ctx, { deny: ['mcp__app__read'] })) })
    await denied
    expect((await f.invoke(scoped.value)).error?.info?.code).toBe('UNKNOWN_TOOL')
    await denied.dispose()
    expect((await f.invoke(scoped.value)).isError).toBe(false)
    await bridge.dispose()
    expect((await f.invoke(scoped.value)).error?.info?.code).toBe('UNKNOWN_TOOL')
  })

  it.each([{ allow: [] }, { deny: ['mcp__app__read'] }])('enforces endpoint restrictions %j', async (overrides) => {
    const f = await applicationFixture()
    const scoped = f.agent('owned', f.owner)
    await f.mount(overrides)
    expect((await f.invoke(scoped.value)).error?.info?.code).toBe('UNKNOWN_TOOL')
    expect(f.requests).toEqual([])
  })

  it('removes an Agent catalog when its scope disposes', async () => {
    const f = await applicationFixture()
    const scoped = f.agent('owned', f.owner)
    await f.mount()
    await scoped.scope.dispose()
    expect((await f.invoke(scoped.value)).error?.info?.code).toBe('UNKNOWN_TOOL')
    expect(f.requests).toEqual([])
  })

  it('keeps a single catalog when an existing Agent is re-registered', async () => {
    const f = await applicationFixture()
    const scoped = f.agent('owned', f.owner)
    await f.mount()
    await scoped.unregister()
    await scoped.scope.ctx.agents.register(scoped.value)
    expect((await f.invoke(scoped.value)).isError).toBe(false)
    expect(f.requests).toHaveLength(1)
  })

  it('reauthorizes a retained definition even after scoped registration is revoked', async () => {
    const f = await applicationFixture()
    const scoped = f.agent('owned', f.owner)
    await f.mount()
    const definition = f.root.tools.get('mcp__app__read', scoped.value)
    if (definition === undefined) throw new Error('Application tool was not registered')
    const execution: ToolRunContext = {
      name: definition.name, callId: ToolCallId('retained'), rootCallId: ToolCallId('retained'),
      token: Symbol('retained') as ToolExecutionToken, arguments: {}, signal: new AbortController().signal,
      deferContext() { throw new Error('Unexpected deferred context') },
      concludeTurn() { throw new Error('Unexpected terminal result') },
    }
    await expect(definition.execute({}, execution)).rejects.toThrow('requires an Agent')
    scoped.scope.ctx.effect(() => registerPolicy(scoped.scope.ctx, { deny: [definition.name] }))
    await expect(definition.execute({}, { ...execution, agent: scoped.value })).rejects.toThrow('not allowed')
    expect(f.requests).toEqual([])
  })

  it('rolls back catalog publication when an Agent already owns the public name', async () => {
    const f = await applicationFixture()
    const scoped = f.agent('owned', f.owner)
    scoped.scope.ctx.tools.register({
      name: 'mcp__app__read', description: 'Existing tool', parameters: { type: 'object' },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value as string }] },
      execute: async () => 'existing',
    })
    const original = f.root.tools.get('mcp__app__read', scoped.value)
    await expect(f.mount()).rejects.toThrow('could not start')
    expect(applicationToolNames(f.root).size).toBe(0)
    expect(f.root.tools.get('mcp__app__read', scoped.value)).toBe(original)
  })

  it('rejects invalid modern HTTP tool arguments before dispatch', async () => {
    const f = await applicationFixture()
    const scoped = f.agent('owned', f.owner)
    f.setCatalog([{
      name: 'read',
      inputSchema: {
        $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object',
        properties: { id: { type: 'integer' } }, required: ['id'],
      },
    }])
    await f.mount()
    expect(f.root.tools.get('mcp__app__read', scoped.value)?.parameters).not.toHaveProperty('$schema')
    const result = await f.invoke(scoped.value)
    expect(result.isError).toBe(true)
    expect(result.error?.info?.code).toBe('INVALID_ARGS')
    expect(f.requests).toEqual([])
  })

  it('reports a failed initial catalog and permits configured nonfatal startup', async () => {
    const f = await applicationFixture()
    f.setCatalog([{ name: 'read', inputSchema: { type: 'object', patternProperties: {} } }])
    await expect(f.mount()).rejects.toThrow('could not start')
    await expect(f.mount({ failOnStartupError: false })).resolves.toBeDefined()
  })
})
