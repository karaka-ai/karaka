import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import {
  lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, symlinkSync, unlinkSync,
  writeFileSync,
} from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { boot, healProfilesModuleFallback, loadOptionalPatches, loadProfile } from '@deepseek-ai/dsh-app-boot'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { initKarakaProject, karakaVersion, ownKarakaChild, prepareKarakaProfile } from '@karaka/cli'
import { createKarakaClient, createKarakaToolHost } from '@karaka/sdk'
import { z } from 'zod'

const require = createRequire(import.meta.url)

describe('karaka init', () => {
  it('reports the installed CLI version used by release probes', () => {
    expect(karakaVersion).toBe('0.1.2-alpha.2')
  })

  it('creates separate setup and Agent Preset files without overwriting edits', () => {
    const target = join(mkdtempSync(join(tmpdir(), 'karaka-init-')), 'agents-app')
    const root = initKarakaProject(target)

    expect(readFileSync(join(root, 'karaka.cordis.yml'), 'utf8')).not.toContain('@deepseek-ai/dsh-mcp-client')
    expect(readFileSync(join(root, 'agents/support/preset.yml'), 'utf8')).toContain('name: Support')
    const agent = readFileSync(join(root, 'agents/support/agent.cordis.yml'), 'utf8')
    expect(agent).toContain('@deepseek-ai/dsh-persona')
    expect(agent).toContain('@deepseek-ai/dsh-agent-tool-presentation')
    expect(agent).toContain('allow: []')
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toBe('.karaka/\n')

    writeFileSync(join(root, 'agents/support/agent.cordis.yml'), '# developer edit\n')
    writeFileSync(join(root, '.gitignore'), 'node_modules/\n.karaka/\n')
    initKarakaProject(target)
    expect(readFileSync(join(root, 'agents/support/agent.cordis.yml'), 'utf8')).toBe('# developer edit\n')
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toBe('node_modules/\n.karaka/\n')
    expect(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))).toMatchObject({
      dependencies: { '@karaka/cli': '0.1.2-alpha.2', '@karaka/harness': '0.1.2-alpha.2' },
    })
  })

  it('prepares the Harness home and makes the Karaka bundle profile-resolvable', () => {
    const project = mkdtempSync(join(tmpdir(), 'karaka-profile-'))
    const prepared = prepareKarakaProfile(project)
    const dshManifest = require.resolve('@deepseek-ai/dsh/package.json')
    const profile = loadProfile('karaka-test', 'karaka', dshManifest, prepared.home)

    if (process.platform !== 'win32') expect(statSync(prepared.home).mode & 0o077).toBe(0)
    expect(profile.layers.map(layer => layer.packageName)).toEqual([
      '@deepseek-ai/dsh-base',
      '@karaka/harness',
    ])
    expect(realpathSync(join(prepared.profileDir, 'node_modules/@karaka/harness')))
      .toBe(realpathSync(join(require.resolve('@karaka/harness/package.json'), '..')))
  })

  it('loads an Agent plugin installed only in the Karaka project', async () => {
    const project = mkdtempSync(join(tmpdir(), 'karaka-project-plugin-'))
    initKarakaProject(project)
    const manifestPath = join(project, 'package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      dependencies: Record<string, string>
    }
    manifest.dependencies['karaka-fixture-plugin'] = '1.0.0'
    writeFileSync(manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`)
    const pluginDir = join(project, 'node_modules/karaka-fixture-plugin')
    mkdirSync(pluginDir, { recursive: true })
    writeFileSync(join(pluginDir, 'package.json'), JSON.stringify({
      name: 'karaka-fixture-plugin',
      version: '1.0.0',
      type: 'module',
      exports: './index.js',
    }))
    writeFileSync(join(pluginDir, 'index.js'), `export const name = 'karaka-fixture-plugin'
export function apply(ctx) {
  ctx.effect(() => () => {}, 'karaka-fixture-plugin')
}
`)
    writeFileSync(join(project, 'agents/support/agent.cordis.yml'), `- id: fixture
  name: karaka-fixture-plugin
`)

    const prepared = prepareKarakaProfile(project)
    expect(realpathSync(join(prepared.profileDir, 'node_modules/karaka-fixture-plugin')))
      .toBe(realpathSync(pluginDir))
    const dshManifest = require.resolve('@deepseek-ai/dsh/package.json')
    const profile = loadProfile('karaka-test', 'karaka', dshManifest, prepared.home)
    await healProfilesModuleFallback({ installAnchor: dshManifest, profile, home: prepared.home })
    const configPath = join(prepared.profileDir, 'cordis.yml')
    writeFileSync(configPath, '[]\n')
    vi.stubEnv('DSH_HOME', prepared.home)
    vi.stubEnv('KARAKA_AGENTS_DIR', join(project, 'agents'))
    vi.stubEnv('KARAKA_PORT', '0')
    let ctx: Awaited<ReturnType<typeof boot>> | undefined
    try {
      ctx = await boot('karaka-test', configPath, profile.layers.flatMap(layer => layer.patches))
      await expect(ctx.agentPresets.resolve('support')).resolves.not.toHaveProperty('broken')
      await expect(ctx.agentPresets.standingKeyFor('support')).resolves.toEqual({ agentPreset: 'support' })
    } finally {
      await ctx?.fiber.dispose()
      vi.unstubAllEnvs()
    }
  }, 30_000)

  it('follows project dependency updates and stops resolving uninstalled packages', () => {
    const project = mkdtempSync(join(tmpdir(), 'karaka-project-update-'))
    initKarakaProject(project)
    const manifestPath = join(project, 'package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      dependencies: Record<string, string>
    }
    manifest.dependencies['karaka-updated-plugin'] = '1.0.0'
    writeFileSync(manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`)
    const storeA = join(project, 'store/plugin-a')
    const storeB = join(project, 'store/plugin-b')
    for (const path of [storeA, storeB]) {
      mkdirSync(path, { recursive: true })
      writeFileSync(join(path, 'package.json'), '{}\n')
    }
    const projectLink = join(project, 'node_modules/karaka-updated-plugin')
    mkdirSync(join(project, 'node_modules'), { recursive: true })
    symlinkSync(storeA, projectLink, 'junction')

    const prepared = prepareKarakaProfile(project)
    const profileLink = join(prepared.profileDir, 'node_modules/karaka-updated-plugin')
    expect(realpathSync(profileLink)).toBe(realpathSync(storeA))

    unlinkSync(projectLink)
    symlinkSync(storeB, projectLink, 'junction')
    prepareKarakaProfile(project)
    expect(realpathSync(profileLink)).toBe(realpathSync(storeB))

    delete manifest.dependencies['karaka-updated-plugin']
    writeFileSync(manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`)
    prepareKarakaProfile(project)
    expect(realpathSync(projectLink)).toBe(realpathSync(storeB))
    expect(() => lstatSync(profileLink)).toThrow()
  })

  it('forwards supervisor termination to the Harness child and removes listeners', async () => {
    const signals = new EventEmitter()
    const child = Object.assign(new EventEmitter(), {
      exitCode: null,
      signalCode: null,
      kill: vi.fn(() => true),
    })
    const exit = ownKarakaChild(child as never, signals)

    signals.emit('SIGTERM')
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    signals.emit('SIGINT')
    expect(child.kill).toHaveBeenLastCalledWith('SIGKILL')
    signals.emit('SIGINT')
    expect(child.kill).toHaveBeenCalledTimes(2)
    child.emit('exit', 0, null)

    await expect(exit).resolves.toBe(0)
    expect(signals.listenerCount('SIGTERM')).toBe(0)
    expect(signals.listenerCount('SIGINT')).toBe(0)
  })

  it('boots the shipped Karaka profile through the real Loader', async () => {
    const project = mkdtempSync(join(tmpdir(), 'karaka-loader-'))
    initKarakaProject(project)
    const prepared = prepareKarakaProfile(project)
    const dshManifest = require.resolve('@deepseek-ai/dsh/package.json')
    const profile = loadProfile('karaka-test', 'karaka', dshManifest, prepared.home)
    await healProfilesModuleFallback({ installAnchor: dshManifest, profile, home: prepared.home })
    const configPath = join(prepared.profileDir, 'cordis.yml')
    writeFileSync(configPath, '[]\n')
    vi.stubEnv('DSH_HOME', prepared.home)
    vi.stubEnv('KARAKA_AGENTS_DIR', join(project, 'agents'))
    vi.stubEnv('KARAKA_PORT', '0')
    let ctx: Awaited<ReturnType<typeof boot>> | undefined
    try {
      ctx = await boot('karaka-test', configPath, profile.layers.flatMap(layer => layer.patches))
      expect(ctx.get('sessionController')).toBeDefined()
      expect(ctx.get('serverAuth')).toBeDefined()
      expect(ctx.get('webServer')).toBeDefined()
      await expect(ctx.sessionController.application.listAgents())
        .resolves.toContainEqual(expect.objectContaining({ id: 'support' }))
    } finally {
      await ctx?.fiber.dispose()
      vi.unstubAllEnvs()
    }
  }, 30_000)

  it('runs a real authenticated SDK chat through the loaded Agent Preset', async () => {
    const project = mkdtempSync(join(tmpdir(), 'karaka-chat-'))
    initKarakaProject(project)
    const prepared = prepareKarakaProfile(project)
    const dshManifest = require.resolve('@deepseek-ai/dsh/package.json')
    const profile = loadProfile('karaka-test', 'karaka', dshManifest, prepared.home)
    await healProfilesModuleFallback({ installAnchor: dshManifest, profile, home: prepared.home })
    const configPath = join(prepared.profileDir, 'cordis.yml')
    const deploymentPatch = join(project, 'karaka.cordis.yml')
    writeFileSync(configPath, '[]\n')
    writeFileSync(deploymentPatch, `- id: server-auth
  config:
    applications:
      - id: billing
        chatCredential: KARAKA_TEST_CHAT_TOKEN
        toolCredential: KARAKA_TEST_TOOL_TOKEN
`)
    vi.stubEnv('DSH_HOME', prepared.home)
    vi.stubEnv('KARAKA_AGENTS_DIR', join(project, 'agents'))
    vi.stubEnv('KARAKA_PORT', '0')
    let ctx: Awaited<ReturnType<typeof boot>> | undefined
    try {
      ctx = await boot('karaka-test', configPath, [
        ...profile.layers.flatMap(layer => layer.patches),
        ...loadOptionalPatches('karaka-test', deploymentPatch) ?? [],
      ])
      await ctx.credentials.set(credentialRef('KARAKA_TEST_CHAT_TOKEN'), 'chat-secret')
      await expect(ctx.serverAuth.authenticate('Bearer chat-secret'))
        .resolves.toEqual({ applicationId: 'billing' })
      ctx.llm.registerAdapter(['fixture'], new TextAdapter('Hello from Support'))
      const client = createKarakaClient({
        endpoint: `http://127.0.0.1:${String(ctx.webServer.port)}`,
        chatToken: 'chat-secret',
      })
      const user = client.forUser({ tenantId: 'tenant-1', userId: 'user-1' })

      await expect(client.agents.list()).resolves.toContainEqual(expect.objectContaining({ id: 'support' }))
      await expect(user.chats.create({ chatId: 'chat-1', agentId: 'support' }))
        .resolves.toEqual({ chatId: 'chat-1', agentId: 'support' })
      await expect(user.chats.create({ chatId: 'empty-chat', agentId: 'support' }))
        .resolves.toEqual({ chatId: 'empty-chat', agentId: 'support' })
      await user.chats.setModel('chat-1', { provider: 'fixture', model: 'fixture-model' })
      await expect(user.chats.send({
        chatId: 'chat-1',
        requestId: 'request-1',
        content: 'Help me',
      })).resolves.toMatchObject({ accepted: true, duplicate: false })
      await vi.waitFor(async () => {
        const history = await user.chats.history('chat-1')
        const assistant = history.events.find(event => event.type === 'assistant-message')
        expect(assistant).toBeDefined()
        if (assistant?.type === 'assistant-message') {
          expect(typeof assistant.content).toBe('object')
          expect(assistant.content).not.toBeNull()
          if (typeof assistant.content === 'object' && assistant.content !== null) {
            expect(Reflect.get(assistant.content, 'role')).toBe('assistant')
          }
        }
      }, { timeout: 5_000 })

      await ctx.fiber.dispose()
      ctx = await boot('karaka-test', configPath, [
        ...profile.layers.flatMap(layer => layer.patches),
        ...loadOptionalPatches('karaka-test', deploymentPatch) ?? [],
      ])
      const resumed = createKarakaClient({
        endpoint: `http://127.0.0.1:${String(ctx.webServer.port)}`,
        chatToken: 'chat-secret',
      })
      await expect(resumed.forUser({ tenantId: 'tenant-1', userId: 'intruder' }).chats.history('chat-1'))
        .rejects.toMatchObject({ code: 'CHAT_FORBIDDEN' })
      const resumedHistory = await resumed.forUser({ tenantId: 'tenant-1', userId: 'user-1' }).chats.history('chat-1')
      expect(resumedHistory.chatId).toBe('chat-1')
      expect(resumedHistory.events.length).toBeGreaterThan(0)
      await expect(resumed.forUser({ tenantId: 'tenant-1', userId: 'intruder' }).chats.history('empty-chat'))
        .rejects.toMatchObject({ code: 'CHAT_FORBIDDEN' })
      await expect(resumed.forUser({ tenantId: 'tenant-1', userId: 'user-1' }).chats.history('empty-chat'))
        .resolves.toEqual({ chatId: 'empty-chat', events: [] })
    } finally {
      await ctx?.fiber.dispose()
      vi.unstubAllEnvs()
    }
  }, 30_000)

  it('loads an allowed authenticated application tool through the complete profile', async () => {
    const callback = vi.fn(() => ({ content: [{ type: 'text' as const, text: 'refunded inv-1' }] }))
    const toolHost = createKarakaToolHost({ verifyToken: 'tool-secret' })
    toolHost.registerTool('invoices_refund', {
      description: 'Refund an invoice',
      inputSchema: z.object({ invoiceId: z.string() }).strict(),
    }, callback)
    const handler = toolHost.expressHandler()
    const toolServer = createServer((request, response) => { void handler(request, response) })
    await new Promise<void>((resolve, reject) => {
      toolServer.once('error', reject)
      toolServer.listen(0, '127.0.0.1', resolve)
    })

    let ctx: Awaited<ReturnType<typeof boot>> | undefined
    try {
      const project = mkdtempSync(join(tmpdir(), 'karaka-tool-chat-'))
      initKarakaProject(project)
      writeFileSync(join(project, 'agents/support/agent.cordis.yml'), `- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    text: You are a helpful support agent.
    complete: true
    includeRuntimeContext: false

- id: tools
  name: '@deepseek-ai/dsh-agent-tool-presentation'
  config:
    mode: native
    allow:
      - mcp__billing__invoices_refund
`)
      const prepared = prepareKarakaProfile(project)
      const dshManifest = require.resolve('@deepseek-ai/dsh/package.json')
      const profile = loadProfile('karaka-test', 'karaka', dshManifest, prepared.home)
      await healProfilesModuleFallback({ installAnchor: dshManifest, profile, home: prepared.home })
      const configPath = join(prepared.profileDir, 'cordis.yml')
      const deploymentPatch = join(project, 'karaka.cordis.yml')
      const toolAddress = toolServer.address() as AddressInfo
      writeFileSync(configPath, '[]\n')
      writeFileSync(deploymentPatch, `- id: server-auth
  config:
    applications:
      - id: billing
        chatCredential: KARAKA_TEST_CHAT_TOKEN
        toolCredential: KARAKA_TEST_TOOL_TOKEN

- insert:
    - id: billing-tools
      name: '@karaka/mcp-application'
      config:
        serverName: billing
        url: http://127.0.0.1:${String(toolAddress.port)}
        applicationId: billing
        failOnStartupError: true
`)
      vi.stubEnv('DSH_HOME', prepared.home)
      vi.stubEnv('KARAKA_AGENTS_DIR', join(project, 'agents'))
      vi.stubEnv('KARAKA_PORT', '0')
      vi.stubEnv('KARAKA_TEST_CHAT_TOKEN', 'chat-secret')
      vi.stubEnv('KARAKA_TEST_TOOL_TOKEN', 'tool-secret')
      ctx = await boot('karaka-test', configPath, [
        ...profile.layers.flatMap(layer => layer.patches),
        ...loadOptionalPatches('karaka-test', deploymentPatch) ?? [],
      ])
      const adapter = new ToolThenTextAdapter()
      ctx.llm.registerAdapter(['fixture'], adapter)
      const client = createKarakaClient({
        endpoint: `http://127.0.0.1:${String(ctx.webServer.port)}`,
        chatToken: 'chat-secret',
      })
      const chats = client.forUser({ tenantId: 'tenant-1', userId: 'user-1' }).chats
      await chats.create({ chatId: 'tool-chat', agentId: 'support' })
      await chats.setModel('tool-chat', { provider: 'fixture', model: 'fixture-model' })
      await chats.send({
        chatId: 'tool-chat',
        requestId: 'tool-request',
        content: 'Refund invoice inv-1',
      })

      await vi.waitFor(() => {
        expect(callback).toHaveBeenCalledWith(
          { invoiceId: 'inv-1' },
          expect.objectContaining({
            applicationId: 'billing', tenantId: 'tenant-1', userId: 'user-1', chatId: 'tool-chat',
          }),
        )
      }, { timeout: 5_000 })
      await vi.waitFor(async () => {
        const history = await chats.history('tool-chat')
        expect(history.events.some(event => event.type === 'tool-result')).toBe(true)
        expect(history.events.some(event => event.type === 'assistant-message')).toBe(true)
      }, { timeout: 5_000 })
      expect(adapter.requests[0]?.tools?.map(tool => tool.name))
        .toContain('mcp__billing__invoices_refund')
    } finally {
      await ctx?.fiber.dispose()
      await toolHost.close()
      toolServer.closeAllConnections()
      await new Promise<void>(resolve => toolServer.close(() => { resolve() }))
      vi.unstubAllEnvs()
    }
  }, 30_000)
})

class TextAdapter extends LlmAdapter {
  constructor(private readonly text: string) {
    super()
  }

  async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: this.text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: this.text } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 3 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

class ToolThenTextAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (this.requests.length === 1) {
      const id = ToolCallId('refund-call')
      const arguments_ = JSON.stringify({ invoiceId: 'inv-1' })
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: 'mcp__billing__invoices_refund', argumentsDelta: arguments_ }
      yield {
        type: 'block-end',
        index: 0,
        block: { type: 'tool-call', id, name: 'mcp__billing__invoices_refund', arguments: arguments_ },
      }
      yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'Refunded' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Refunded' } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
