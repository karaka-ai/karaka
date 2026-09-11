import { mkdtemp, mkdir, readFile, writeFile, rm, copyFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execa } from 'execa'
import { exportSPKI, generateKeyPair, SignJWT } from 'jose'
import { assert, describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TypertRemoteNamespace$73657373696f6e } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-api-session-controller/remote'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import { initKarakaProject, prepareKarakaRuntime } from '@karaka-ai/cli'

interface BrowserTestClient {
  readonly chats: Pick<TypertRemoteNamespace$73657373696f6e,
    'applicationAgents' | 'applicationCreate' | 'applicationPrompt' | 'applicationHistory' | 'applicationCancel' | 'applicationFollow'>
  readonly connection: {
    readonly state: { getSnapshot(): string }
    readonly generation: { getSnapshot(): { id: number } | undefined }
    reconnect(): void
  }
  forChat(id: string): {
    $on(event: 'approval/request', handler: (request: { reason: string; signal?: AbortSignal }) => Promise<ApprovalOutcome>): unknown
    $on(event: 'user-questions/request', handler: (request: { questions: { question: string }[] }) => Promise<unknown>): unknown
  }
  dispose(): Promise<void>
}

const packageRoot = fileURLToPath(new URL('../', import.meta.url))
const origin = 'https://frontend.example'

function launchKaraka(bin: string, project: string, home: string) {
  return execa(process.execPath, [bin, '--config', join(project, 'karaka.cordis.yml')], {
    cwd: project, reject: false, timeout: 90_000, killSignal: 'SIGKILL',
    env: { KARAKA_HOME: home, KARAKA_AGENTS_DIR: join(project, 'agents'), KARAKA_PORT: '0', DSH_TELEMETRY_DISABLED: '1' },
  })
}

describe('Karaka authenticated browser composition', () => {
  it('isolates two users, resumes their tools, and authenticates reconnects', { retry: 0 }, async () => {
    const project = await mkdtemp(join(tmpdir(), 'karaka-browser-'))
    const clients: { dispose(): Promise<void> }[] = []
    const sockets: WebSocket[] = []
    let child: ReturnType<typeof launchKaraka> | undefined
    try {
      initKarakaProject(project)
      const runtime = prepareKarakaRuntime(project)
      await mkdir(join(project, 'node_modules/@karaka-ai'), { recursive: true })
      await symlink(packageRoot, join(project, 'node_modules/@karaka-ai/agent'), 'junction')
      const { privateKey, publicKey } = await generateKeyPair('ES256')
      const sign = (user: string, seconds = 120) => new SignJWT({ applicationId: 'test', tenantId: 'tenant', userId: user })
        .setProtectedHeader({ alg: 'ES256', kid: 'test' }).setIssuer('test-backend').setAudience('karaka')
        .setIssuedAt().setExpirationTime(Math.floor(Date.now() / 1000) + seconds).sign(privateKey)
      const readyFile = join(project, 'ready')
      await mkdir(join(project, 'plugins'), { recursive: true })
      await copyFile(join(packageRoot, 'tests/fixtures/browser-flow.mjs'), join(project, 'plugins/browser-flow.mjs'))
      await writeFile(join(project, 'agents/support/agent.cordis.yml'), JSON.stringify([
        { id: 'persona', name: '@karaka-ai/agent/persona', config: { text: 'Complete the requested action.', complete: true, includeRuntimeContext: false } },
        { id: 'presentation', name: '@karaka-ai/agent/agent-tool-presentation', config: { mode: 'native', allow: ['confirm_action'] } },
      ]))
      const methods = ['applicationAgents', 'applicationCreate', 'applicationPrompt', 'applicationHistory', 'applicationFollow', 'applicationCancel']
      await writeFile(join(project, 'karaka.cordis.yml'), JSON.stringify([
        { id: 'llm-deepseek', disabled: true }, { id: 'session-title-llm', disabled: true }, { id: 'session-telemetry-otel', disabled: true },
        { id: 'agent-default-model', config: { provider: 'fixture', model: 'fixture' } },
        { id: 'karaka-http', config: { handleQuestions: false } },
        { insert: [
          { id: 'browser-auth', name: '@karaka-ai/agent/browser-auth', config: { applicationId: 'test', issuer: 'test-backend', audience: 'karaka', maxTokenAgeSeconds: 300, keys: [{ id: 'test', algorithm: 'ES256', publicKey: await exportSPKI(publicKey) }] } },
          { id: 'browser-connection', name: '@karaka-ai/agent/client-connection', config: { authentication: 'application', frontendOrigins: [origin] } },
          { id: 'browser-remotes', name: '@karaka-ai/agent/api-remotes', config: { applicationMethods: methods, applicationEvents: ['approval/request', 'user-questions/request'] } },
          { id: 'browser-fixture', name: './plugins/browser-flow.mjs', config: { readyFile } },
        ] },
      ]))
      const running = launchKaraka(runtime.bin, project, runtime.home)
      child = running
      const finished = running.then((result) => { throw new Error(`Karaka exited before readiness: ${result.stderr}`) })
      void finished.catch(() => {})
      let port = ''
      await Promise.race([finished, vi.waitFor(async () => { port = await readFile(readyFile, 'utf8'); expect(Number(port)).toBeGreaterThan(0) }, { timeout: 30_000 })])
      const endpoint = `http://127.0.0.1:${port}`
      const browser = await import(/* @vite-ignore */ pathToFileURL(join(packageRoot, 'lib/browser.js')).href) as {
        createBrowserClient(config: { endpoint: string; credential: () => string | Promise<string> }): Promise<BrowserTestClient>
      }
      let aliceToken = await sign('alice')
      const alice = await browser.createBrowserClient({ endpoint, credential: () => aliceToken })
      const bob = await browser.createBrowserClient({ endpoint, credential: () => sign('bob') })
      clients.push(alice, bob)
      const monitor = async (token: string) => {
        const socket = new WebSocket(`${endpoint.replace('http:', 'ws:')}/api/remote.mux`, ['dsh', `dsh.bearer.${token}`])
        sockets.push(socket)
        const frames: { type: string; clientId?: string; eventId?: string; agentId?: string }[] = []
        socket.addEventListener('message', (event) => {
          const frame = JSON.parse(String(event.data)) as { type: string; value?: (typeof frames)[number] }
          if (frame.type === 'item' && frame.value !== undefined) frames.push(frame.value)
        })
        await new Promise<void>((resolve, reject) => {
          socket.addEventListener('open', () => { resolve() }, { once: true })
          socket.addEventListener('error', () => { reject(new Error('event monitor failed to connect')) }, { once: true })
        })
        socket.send(JSON.stringify({ type: 'open', streamId: 'events', endpoint: '$events', payload: { args: {} } }))
        await vi.waitFor(() => { expect(frames.some(frame => frame.type === 'ready')).toBe(true) })
        return { socket, frames, clientId: frames.find(frame => frame.type === 'ready')!.clientId! }
      }
      const aliceMonitor = await monitor(aliceToken)
      const bobMonitor = await monitor(await sign('bob'))
      const pending = new Map<string, (value: ApprovalOutcome) => void>()
      const asked: string[] = []
      const questions: string[] = []
      for (const [name, client] of [['alice', alice], ['bob', bob]] as const) {
        client.forChat(`${name}-chat`).$on('approval/request', async (request) => {
          asked.push(request.reason)
          return new Promise<ApprovalOutcome>((resolve) => {
            pending.set(name, resolve)
            request.signal?.addEventListener('abort', () => { pending.delete(name); resolve('cancelled') }, { once: true })
          })
        })
        client.forChat(`${name}-chat`).$on('user-questions/request', async (request: { questions: { question: string }[] }) => {
          questions.push(request.questions[0]!.question)
          return { answers: [{ id: 'confirm', selected: [], custom: name }] }
        })
      }
      await vi.waitFor(() => {
        expect(alice.connection.state.getSnapshot()).toBe('connected')
        expect(bob.connection.state.getSnapshot()).toBe('connected')
      }, { timeout: 15_000 })
      await vi.waitFor(async () => {
        const result = await alice.chats.applicationAgents()
        assert(result.ok, JSON.stringify(result))
        expect(result.value).toContainEqual(expect.objectContaining({ id: 'support' }))
      })
      await Promise.all(([['alice', alice], ['bob', bob]] as const).map(async ([name, client]) => {
        expect(await client.chats.applicationCreate({ chatId: SessionId(`${name}-chat`), agentId: 'support' })).toMatchObject({ ok: true })
        expect(await client.chats.applicationPrompt({ chatId: SessionId(`${name}-chat`), requestId: `${name}-message`, content: [{ type: 'text', text: 'Complete the action.' }] })).toMatchObject({ ok: true })
      }))
      await vi.waitFor(() => { expect(asked.sort()).toEqual(['Approve alice', 'Approve bob']) }, { timeout: 15_000 })
      expect(await bob.chats.applicationHistory({ chatId: SessionId('alice-chat') })).toMatchObject({ ok: false })
      expect(await bob.chats.applicationCancel({ chatId: SessionId('alice-chat') })).toMatchObject({ ok: false })
      expect(await bob.chats.applicationPrompt({ chatId: SessionId('alice-chat'), requestId: 'forged', content: [{ type: 'text', text: 'forged' }] })).toMatchObject({ ok: false })
      await vi.waitFor(() => { expect(aliceMonitor.frames.some(frame => frame.type === 'waterfall')).toBe(true) })
      const aliceEventId = aliceMonitor.frames.find(frame => frame.type === 'waterfall')!.eventId!
      for (const clientId of [aliceMonitor.clientId, bobMonitor.clientId]) {
        const response = await fetch(`${endpoint}/api/$events/result`, {
          method: 'POST', headers: { authorization: `Bearer ${await sign('bob')}`, 'content-type': 'application/json', origin },
          body: JSON.stringify({ type: 'client-request', rpcId: 'forged-answer', method: '$events/result', payload: { args: {
            clientId, eventId: aliceEventId, outcome: { kind: 'result', value: 'allowed-once' },
          } } }),
        })
        expect(await response.json()).toMatchObject({ result: { ok: false, error: { code: 'gateway/forbidden' } } })
      }
      expect(pending.has('alice')).toBe(true)
      expect(pending.has('bob')).toBe(true)
      aliceMonitor.socket.close()
      const switched = await monitor(await sign('bob'))
      await vi.waitFor(() => { expect(switched.frames.some(frame => frame.type === 'waterfall')).toBe(true) })
      expect(switched.frames.filter(frame => frame.type === 'waterfall').map(frame => frame.agentId)).toEqual(['bob-chat'])
      const aliceGeneration = alice.connection.generation.getSnapshot()!.id
      aliceToken = await sign('bob')
      alice.connection.reconnect()
      await vi.waitFor(() => { expect(alice.connection.generation.getSnapshot()?.id).toBeGreaterThan(aliceGeneration) })
      expect(await alice.chats.applicationHistory({ chatId: SessionId('alice-chat') })).toMatchObject({ ok: false })
      expect(await alice.chats.applicationHistory({ chatId: SessionId('bob-chat') })).toMatchObject({ ok: true })
      const generation = alice.connection.generation.getSnapshot()!.id
      aliceToken = await sign('alice')
      alice.connection.reconnect()
      await vi.waitFor(() => { expect(alice.connection.generation.getSnapshot()?.id).toBeGreaterThan(generation); expect(asked.filter(value => value === 'Approve alice')).toHaveLength(2) })
      expect(asked.filter(value => value === 'Approve bob')).toHaveLength(1)
      pending.get('alice')!('allowed-once')
      pending.get('bob')!('allowed-once')
      await vi.waitFor(() => { expect(questions.sort()).toEqual(['Confirm alice', 'Confirm bob']) })
      for (const [name, client] of [['alice', alice], ['bob', bob]] as const) {
        await vi.waitFor(async () => {
          const history = await client.chats.applicationHistory({ chatId: SessionId(`${name}-chat`) })
          assert(history.ok, JSON.stringify(history))
          expect(history.value.some((event: { type: string }) => event.type === 'turn/end')).toBe(true)
          expect(JSON.stringify(history.value)).toContain(`${name}:allowed-once:${name}`)
          expect(JSON.stringify(history.value)).not.toContain(name === 'alice' ? 'Approve bob' : 'Approve alice')
        }, { timeout: 15_000 })
      }
      const expiring = await monitor(await sign('alice', 3))
      await vi.waitFor(() => { expect(expiring.socket.readyState).toBe(WebSocket.CLOSED) }, { timeout: 6_000 })
      aliceToken = await sign('alice', -1)
      expect(await alice.chats.applicationHistory({ chatId: SessionId('alice-chat') })).toMatchObject({ ok: false })
      alice.connection.reconnect()
      await vi.waitFor(() => { expect(alice.connection.generation.getSnapshot()).toBeUndefined() })
      aliceToken = await sign('alice')
      alice.connection.reconnect()
      await vi.waitFor(() => { expect(alice.connection.state.getSnapshot()).toBe('connected') })
      expect(await alice.chats.applicationHistory({ chatId: SessionId('alice-chat') })).toMatchObject({ ok: true })
    } finally {
      try {
        await Promise.all(sockets.map(async (socket) => {
          if (socket.readyState === WebSocket.CLOSED) return
          const closed = new Promise<void>((resolve) => { socket.addEventListener('close', () => { resolve() }, { once: true }) })
          socket.close()
          await closed
        }))
        await Promise.all(clients.map(client => client.dispose()))
        if (child !== undefined) {
          child.kill('SIGTERM')
          const result = await child
          expect(result.timedOut, result.stderr).toBe(false)
          expect(result.exitCode, result.stderr).toBe(0)
        }
      } finally {
        await rm(project, { recursive: true, force: true })
      }
    }
  })
})
