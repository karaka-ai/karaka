/** Keyless application-SDK chat through the shipped persistent Karaka Agent. */

import { existsSync } from 'node:fs'
import { generateKeyPairSync, sign } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionPersistenceJsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import type { TypertRemoteNamespace$73657373696f6e } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-api-session-controller/remote'
import {
  formatSystemPromptSnapshot,
  formatToolSchemasSnapshot,
  normalizeSessionSnapshots,
  normalizedSystemPrompts,
  normalizedToolSchemas,
  parseSnapshotManifest,
  type NormalizeContext,
} from '@deepseek-ai/dsh-session-snapshot'
import { createKarakaClient } from '@karaka-ai/sdk'
import { initKarakaProject, prepareKarakaRuntime } from '@karaka-ai/cli'
import { execa, type ResultPromise } from 'execa'
import { describe, expect, it } from 'vitest'

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const scenarioDir = fileURLToPath(new URL('./application-chat/', import.meta.url))
const fixturePath = join(scenarioDir, 'session.jsonl')
const promptPath = join(scenarioDir, 'system-prompt.expected.md')
const schemasPath = join(scenarioDir, 'tool-schemas.expected.json')
const mode = process.env.DSH_SNAPSHOT ?? 'replay'

interface JsonRecord {
  [key: string]: unknown
}

interface RunningKaraka {
  readonly child: ResultPromise
  readonly endpoint: string
  readonly sessionRoot: string
  readonly credential: string
}

interface BrowserSnapshotClient {
  readonly chats: Pick<TypertRemoteNamespace$73657373696f6e, 'applicationCreate' | 'applicationPrompt' | 'applicationHistory'>
  dispose(): Promise<void>
}

function records(log: string): JsonRecord[] {
  return log.split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line) as JsonRecord)
}

function contextOf(log: string): NormalizeContext {
  const header = records(log)[0] ?? {}
  return {
    sessionIds: typeof header.id === 'string' ? [header.id] : [],
    cwd: typeof header.cwd === 'string' ? header.cwd : '\0missing-cwd\0',
  }
}

async function waitForPort(path: string, child: ResultPromise): Promise<number> {
  const deadline = Date.now() + 15_000
  while (Date.now() <= deadline) {
    if (existsSync(path)) {
      const port = Number(await readFile(path, 'utf8'))
      if (Number.isInteger(port) && port > 0 && port <= 65_535) return port
      throw new Error(`Karaka snapshot readiness file contains invalid port ${String(port)}`)
    }
    if (child.exitCode !== undefined) {
      const result = await child
      throw new Error(`Karaka exited before readiness (${String(result.exitCode)}):\n${result.stderr}`)
    }
    await delay(10)
  }
  throw new Error('Karaka did not publish its listening port within 15 seconds')
}

async function waitForApplicationApi(endpoint: string, child: ResultPromise): Promise<void> {
  const deadline = Date.now() + 15_000
  let lastError: unknown
  while (Date.now() <= deadline) {
    if (child.exitCode !== undefined) {
      const result = await child
      throw new Error(`Karaka exited before its application API was ready (${String(result.exitCode)}):\n${result.stderr}`)
    }
    try {
      const response = await fetch(`${endpoint}/v1/agents`, {
        headers: { authorization: 'Bearer chat-secret' },
      })
      if (response.ok) {
        const agents: unknown = await response.json()
        if (Array.isArray(agents) && agents.some(agent => (
          typeof agent === 'object' && agent !== null && 'id' in agent && agent.id === 'support'
        ))) return
        lastError = new Error('application API has not discovered the support agent')
      } else {
        lastError = new Error(`application API returned HTTP ${String(response.status)}`)
      }
    } catch (error: unknown) {
      lastError = error
    }
    await delay(10)
  }
  child.kill('SIGTERM')
  const result = await child
  throw new Error(
    `Karaka application API did not discover its support agent within 15 seconds. stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    { cause: lastError },
  )
}

async function createReadyPlugin(project: string): Promise<void> {
  const root = join(project, 'node_modules/karaka-snapshot-ready')
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 'package.json'), `${JSON.stringify({
    name: 'karaka-snapshot-ready',
    version: '1.0.0',
    type: 'module',
    exports: './index.js',
  }, undefined, 2)}\n`)
  await writeFile(join(root, 'index.js'), `import { writeFileSync } from 'node:fs'
export const inject = ['webServer']
export function apply(ctx, config) {
  writeFileSync(config.path, String(ctx.webServer.port), { flag: 'wx' })
}
`)
}

async function linkReplayPlugin(project: string): Promise<void> {
  const target = join(project, 'node_modules/@deepseek-ai/dsh-llm-replay')
  await mkdir(dirname(target), { recursive: true })
  await symlink(join(repoRoot, 'packages/test-support/llm-replay'), target, 'junction')
}

async function prepareProject(project: string, readyFile: string): Promise<void> {
  initKarakaProject(project)
  await Promise.all([
    createReadyPlugin(project),
    linkReplayPlugin(project),
    writeFile(join(project, 'agents/support/agent.cordis.yml'), `- id: persona
  name: '@karaka-ai/agent/persona'
  config:
    text: You are a helpful support agent.
    complete: true
    includeRuntimeContext: false

- id: tools
  name: '@karaka-ai/agent/agent-tool-presentation'
  config:
    mode: native
    allow: []
`),
  ])
  const manifestPath = join(project, 'package.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
    dependencies: Record<string, string>
  }
  manifest.dependencies['@deepseek-ai/dsh-llm-replay'] = '0.0.0'
  manifest.dependencies['karaka-snapshot-ready'] = '1.0.0'
  await writeFile(manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`)
  await writeFile(join(project, 'karaka.cordis.yml'), `- id: llm-deepseek
  disabled: true

- id: session-title-llm
  disabled: true

- id: server-auth
  config:
    applications:
      - id: billing
        chatCredential: KARAKA_SNAPSHOT_CHAT_TOKEN
        toolCredential: KARAKA_SNAPSHOT_TOOL_TOKEN
      - id: other-application
        chatCredential: KARAKA_SNAPSHOT_OTHER_CHAT_TOKEN
        toolCredential: KARAKA_SNAPSHOT_OTHER_TOOL_TOKEN

- insert:
    - id: llm-replay
      name: '@deepseek-ai/dsh-llm-replay'
      config:
        providers:
          - id: fixture
            name: Fixture
            models:
              - id: fixture-model

    - id: snapshot-ready
      name: karaka-snapshot-ready
      config:
        path: ${JSON.stringify(readyFile)}
`)
}

async function startKaraka(project: string, browser = false): Promise<RunningKaraka> {
  const readyFile = join(project, 'karaka-ready')
  await rm(readyFile, { force: true })
  let credential = ''
  if (browser) {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const now = Math.floor(Date.now() / 1000)
    const unsigned = [
      { alg: 'RS256', kid: 'snapshot' },
      { iss: 'snapshot-backend', aud: 'karaka', iat: now, exp: now + 120,
        applicationId: 'billing', tenantId: 'tenant-1', userId: 'user-1' },
    ].map(value => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.')
    credential = `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), privateKey).toString('base64url')}`
    const patch = await readFile(join(project, 'karaka.cordis.yml'), 'utf8')
    await writeFile(join(project, 'karaka.cordis.yml'), `${patch}
- insert:
    - id: browser-auth
      name: '@karaka-ai/agent/browser-auth'
      config: ${JSON.stringify({ applicationId: 'billing', issuer: 'snapshot-backend', audience: 'karaka', maxTokenAgeSeconds: 300,
        keys: [{ id: 'snapshot', algorithm: 'RS256', publicKey: publicKey.export({ type: 'spki', format: 'pem' }) }] })}
    - id: browser-connection
      name: '@karaka-ai/agent/client-connection'
      config: { authentication: application, frontendOrigins: ['https://frontend.example'] }
    - id: browser-remotes
      name: '@karaka-ai/agent/api-remotes'
      config: { applicationMethods: [applicationCreate, applicationPrompt, applicationHistory] }
`)
  }
  const prepared = prepareKarakaRuntime(project)
  const child = execa(process.execPath, [prepared.bin, '--config', join(project, 'karaka.cordis.yml')], {
    cwd: project,
    env: {
      KARAKA_HOME: prepared.home,
      DSH_SNAPSHOT: 'replay',
      DSH_SNAPSHOT_FILE: fixturePath,
      DSH_TELEMETRY_DISABLED: '1',
      KARAKA_AGENTS_DIR: join(project, 'agents'),
      KARAKA_PORT: '0',
      KARAKA_SNAPSHOT_CHAT_TOKEN: 'chat-secret',
      KARAKA_SNAPSHOT_TOOL_TOKEN: 'tool-secret',
      KARAKA_SNAPSHOT_OTHER_CHAT_TOKEN: 'other-chat-secret',
      KARAKA_SNAPSHOT_OTHER_TOOL_TOKEN: 'other-tool-secret',
      NODE_OPTIONS: [process.env.NODE_OPTIONS, '--disable-warning=ExperimentalWarning'].filter(Boolean).join(' '),
    },
    reject: false,
    timeout: 30_000,
    killSignal: 'SIGKILL',
  })
  const endpoint = await waitForKarakaStartup(readyFile, child)
  return {
    child,
    endpoint,
    sessionRoot: join(prepared.home, 'sessions'),
    credential,
  }
}

async function waitForKarakaStartup(readyFile: string, child: ResultPromise): Promise<string> {
  try {
    const port = await waitForPort(readyFile, child)
    const endpoint = `http://127.0.0.1:${String(port)}`
    await waitForApplicationApi(endpoint, child)
    return endpoint
  } catch (error: unknown) {
    if (child.exitCode === undefined) child.kill('SIGKILL')
    const result = await child
    throw new Error(`Karaka startup failed: ${String(error)}. stdout:\n${result.stdout}\nstderr:\n${result.stderr}`, { cause: error })
  }
}

async function stopKaraka(running: RunningKaraka): Promise<void> {
  if (running.child.exitCode === undefined) running.child.kill('SIGTERM')
  const result = await running.child
  expect(result.timedOut, `Karaka shutdown stderr:\n${result.stderr}`).toBe(false)
  expect(result.exitCode, `Karaka shutdown stderr:\n${result.stderr}`).toBe(0)
}

async function readPersistedSession(root: string): Promise<string> {
  const ctx = new Context()
  try {
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionPersistenceJsonl, { root })
    const headers = await ctx.sessionPersistence.list()
    expect(headers).toHaveLength(1)
    const header = headers[0]
    if (header === undefined) throw new Error('Karaka snapshot JSONL root has no session')
    const backend = ctx.sessionPersistence as SessionPersistenceJsonl
    const location = backend.locate(header)
    expect(location.kind).toBe('jsonl')
    expect(location.path.startsWith(`${root}${sep}`)).toBe(true)
    expect(location.path).toMatch(/\.jsonl\.zstd$/u)
    const physical = await readFile(location.path)
    expect(physical.subarray(0, 4)).toEqual(Buffer.from([0x28, 0xb5, 0x2f, 0xfd]))
    expect(existsSync(join(dirname(root), 'karaka-sessions.sqlite'))).toBe(false)
    // Read stored events directly: load/inspect may synthesize crash-recovery events.
    const loaded = await backend.loadStored(header.id)
    if (loaded === undefined) throw new Error('Karaka snapshot session has no stored JSONL')
    expect(loaded.tornMarker).toBeUndefined()
    await expect(readFile(location.path)).resolves.toEqual(physical)
    return [JSON.stringify({ type: 'session', ...loaded.meta }), ...loaded.events.map(event => JSON.stringify(event)), ''].join('\n')
  } finally {
    await ctx.fiber.dispose()
  }
}

async function compareOrRefresh(actualLog: string): Promise<void> {
  const actualContext = contextOf(actualLog)
  const actual = normalizeSessionSnapshots([actualLog], actualContext)[0]
  if (actual === undefined) throw new Error('Karaka snapshot normalization produced no session')
  const prompts = normalizedSystemPrompts(actualLog, actualContext)
  const schemas = normalizedToolSchemas(actualLog, actualContext)
  const prompt = formatSystemPromptSnapshot(prompts[0] as string, prompts.slice(1))
  const toolSchemas = formatToolSchemasSnapshot(schemas[0] as unknown[], schemas.slice(1))
  if (mode === 'refresh') {
    await Promise.all([
      writeFile(fixturePath, actual),
      writeFile(promptPath, prompt),
      writeFile(schemasPath, toolSchemas),
    ])
    return
  }
  const expectedLog = await readFile(fixturePath, 'utf8')
  const expected = normalizeSessionSnapshots([expectedLog], contextOf(expectedLog))[0]
  expect(actual).toBe(expected)
  await expect(readFile(promptPath, 'utf8')).resolves.toBe(prompt)
  await expect(readFile(schemasPath, 'utf8')).resolves.toBe(toolSchemas)
}

describe('Karaka recorded-session snapshot', () => {
  it('reaps the Karaka child when startup readiness is invalid', async () => {
    const project = await mkdtemp(join(tmpdir(), 'karaka-startup-failure-'))
    const readyFile = join(project, 'karaka-ready')
    await writeFile(readyFile, 'invalid\n')
    const child = execa(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { reject: false })
    let settled = false
    try {
      await expect(waitForKarakaStartup(readyFile, child)).rejects.toThrow('invalid port')
      await expect(child).resolves.toMatchObject({ signal: 'SIGKILL' })
      settled = true
    } finally {
      if (!settled) {
        child.kill('SIGKILL')
        await child
      }
      await rm(project, { recursive: true, force: true })
    }
  })

  it.skipIf(mode === 'record').each(['backend', 'browser'] as const)('replays an authenticated %s chat through @karaka-ai/agent', async (transport) => {
    const manifestPath = join(scenarioDir, 'snapshot.yml')
    const manifest = parseSnapshotManifest(await readFile(manifestPath, 'utf8'), manifestPath)
    expect(manifest).toMatchObject({ profile: 'karaka', recording: 'authored' })
    const project = await mkdtemp(join(tmpdir(), 'karaka-snapshot-'))
    let running: RunningKaraka | undefined
    let browser: BrowserSnapshotClient | undefined
    try {
      await prepareProject(project, join(project, 'karaka-ready'))
      running = await startKaraka(project, transport === 'browser')
      const client = createKarakaClient({ endpoint: running.endpoint, chatToken: 'chat-secret' })
      const user = client.forUser({ tenantId: 'tenant-1', userId: 'user-1' })
      await expect(client.agents.list()).resolves.toContainEqual(expect.objectContaining({ id: 'support' }))
      if (transport === 'browser') {
        const module = await import(/* @vite-ignore */ pathToFileURL(join(repoRoot, 'packages/karaka/agent/lib/browser.js')).href) as {
          createBrowserClient(config: { endpoint: string; credential: () => string }): Promise<BrowserSnapshotClient>
        }
        const token = running.credential
        browser = await module.createBrowserClient({ endpoint: running.endpoint, credential: () => token })
        expect(await browser.chats.applicationCreate({ chatId: SessionId('snapshot-chat'), agentId: 'support' })).toMatchObject({ ok: true })
      } else {
        await expect(user.chats.create({ chatId: 'snapshot-chat', agentId: 'support' }))
          .resolves.toEqual({ chatId: 'snapshot-chat', agentId: 'support' })
      }
      await user.chats.setModel('snapshot-chat', { provider: 'fixture', model: 'fixture-model' })
      if (browser !== undefined) {
        expect(await browser.chats.applicationPrompt({
          chatId: SessionId('snapshot-chat'), requestId: 'snapshot-request',
          content: [{ type: 'text', text: 'Reply with exactly: KARAKA_SNAPSHOT_OK' }],
        })).toMatchObject({ ok: true })
      } else await user.chats.send({
        chatId: 'snapshot-chat',
        requestId: 'snapshot-request',
        content: 'Reply with exactly: KARAKA_SNAPSHOT_OK',
      })
      let history = await user.chats.history('snapshot-chat')
      const deadline = Date.now() + 10_000
      while (!history.events.some(event => event.type === 'turn-end')) {
        if (Date.now() > deadline) throw new Error('Karaka snapshot chat did not finish within 10 seconds')
        await delay(10)
        history = await user.chats.history('snapshot-chat')
      }
      expect(history.events).toContainEqual(expect.objectContaining({ type: 'assistant-message' }))
      if (browser !== undefined) {
        const history = await browser.chats.applicationHistory({ chatId: SessionId('snapshot-chat') })
        expect(history).toMatchObject({ ok: true, value: expect.arrayContaining([expect.objectContaining({ type: 'turn/end' })]) })
        await browser.dispose()
        browser = undefined
      }
      await stopKaraka(running)
      const log = await readPersistedSession(running.sessionRoot)
      expect(records(log)[0]).toMatchObject({
        agentPreset: 'support',
        applicationOwner: { applicationId: 'billing', tenantId: 'tenant-1', userId: 'user-1' },
      })
      await compareOrRefresh(log)

      running = await startKaraka(project)
      const restarted = createKarakaClient({ endpoint: running.endpoint, chatToken: 'chat-secret' })
      const rightfulUser = restarted.forUser({ tenantId: 'tenant-1', userId: 'user-1' })
      const otherApplication = createKarakaClient({ endpoint: running.endpoint, chatToken: 'other-chat-secret' })
      for (const outsider of [
        otherApplication.forUser({ tenantId: 'tenant-1', userId: 'user-1' }),
        restarted.forUser({ tenantId: 'other-tenant', userId: 'user-1' }),
        restarted.forUser({ tenantId: 'tenant-1', userId: 'other-user' }),
      ]) {
        await expect(outsider.chats.history('snapshot-chat')).rejects.toMatchObject({ code: 'CHAT_FORBIDDEN' })
        await expect(outsider.chats.send({
          chatId: 'snapshot-chat', requestId: 'snapshot-request', content: 'unauthorized retry',
        })).rejects.toMatchObject({ code: 'CHAT_FORBIDDEN' })
      }
      await expect(rightfulUser.chats.history('snapshot-chat')).resolves.toEqual(history)
      await expect(rightfulUser.chats.send({
        chatId: 'snapshot-chat', requestId: 'snapshot-request', content: 'duplicate retry',
      })).resolves.toMatchObject({ accepted: true, duplicate: true })
      await stopKaraka(running)
      const original = records(log)
      const resumed = records(await readPersistedSession(running.sessionRoot))
      expect(resumed.slice(0, original.length)).toEqual(original)
      // Agent activation records the restored seed once; a duplicate adds no message or turn.
      expect(resumed.slice(original.length)).toEqual([{
        type: 'session/end-seed', seq: original.length - 1, time: expect.any(Number), data: {},
      }])
    } finally {
      try {
        await browser?.dispose()
      } finally {
        try {
          if (running !== undefined && running.child.exitCode === undefined) {
            running.child.kill('SIGKILL')
            await running.child
          }
        } finally {
          await rm(project, { recursive: true, force: true })
        }
      }
    }
  })
})
