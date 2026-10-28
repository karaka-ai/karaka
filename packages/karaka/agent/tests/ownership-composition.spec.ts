/** Browser authorization and process-local ownership over a real Loader and JSONL restart. */
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SqliteSessionQuery from '@deepseek-ai/dsh-session-query-sqlite'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import AgentDefaultModel from '@deepseek-ai/dsh-agent-default-model'
import AgentPresetRegistry from '@deepseek-ai/dsh-agent-preset-registry'
import AgentPreset from '@deepseek-ai/dsh-agent-preset'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Credentials from '@deepseek-ai/dsh-credentials-local'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import * as Identity from '@karaka-ai/identity'
import ServerAuth from '@karaka-ai/server-auth'
import * as BrowserAuth from '@karaka-ai/browser-auth'
import * as Transport from '@karaka-ai/transport-http'
import * as Startup from '@karaka-ai/transport-http/startup'
import { exportSPKI, generateKeyPair, SignJWT } from 'jose'
import { expect, it, onTestFinished } from 'vitest'
import * as Probe from './fixtures/ownership/probe.ts'

const owner = {
  applicationId: Identity.ApplicationId('app'), tenantId: Identity.TenantId('tenant'), userId: Identity.UserId('user'),
}

it('restores only authorized root chats after restart without local ownership files or inference on history', async () => {
  const root = await mkdtemp(join(tmpdir(), 'karaka-ownership-loader-'))
  const contexts: Context[] = []
  onTestFinished(async () => {
    for (const ctx of contexts.reverse()) await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  })
  const keys = await generateKeyPair('ES256')
  const publicKey = await exportSPKI(keys.publicKey)

  async function boot(generation: number): Promise<Context> {
    const template = await readFile(new URL('./fixtures/ownership/cordis.yml', import.meta.url), 'utf8')
    const config = template.replace('__SESSIONS__', JSON.stringify(join(root, 'sessions')))
      .replace('__CREDENTIALS__', JSON.stringify(join(root, 'credentials.yml')))
      .replace('__PUBLIC_KEY__', JSON.stringify(publicKey))
    const path = join(root, `boot-${generation}.yml`)
    await writeFile(path, config)
    const ctx = new Context()
    contexts.push(ctx)
    ctx.baseUrl = pathToFileURL(root).href + '/'
    const readiness = new Set<() => void>()
    ctx.provide('appReady', { onReady(listener) { readiness.add(listener); return () => { readiness.delete(listener) } } })
    ctx.provide('appExit', (code) => { throw new Error(`Ownership composition exited during startup: ${code}`) })
    await ctx.plugin(Loader)
    Object.assign(ctx.loader.builtins, {
      include: Include, startup: Startup, timer: Timer,
      session: SessionStore, projections: SessionProjectionRegistry, persistence: JsonlSessionPersistence,
      query: SqliteSessionQuery, llm: LlmRuntime, tools: ToolRuntime, nativeExecutor: NativeToolExecutor, systemPrompt: SystemPrompt,
      agents: AgentRegistry, defaultModel: AgentDefaultModel, presets: AgentPresetRegistry, preset: AgentPreset,
      loop: AgentLoop, identity: Identity, credentials: Credentials, serverAuth: ServerAuth,
      browserAuth: BrowserAuth, webServer: WebServer, probe: Probe, presetObserver: Probe.presetObserver, transport: Transport,
    })
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(path).href } })
    await ctx.loader.await()
    for (const entry of ctx.loader.entries()) await entry.fiber?.await()
    for (const listener of readiness) listener()
    expect(ctx.karakaStartup.ready).toBe(true)
    return ctx
  }

  async function token(chatId: string | undefined): Promise<string> {
    return new SignJWT({ ...owner, chatId }).setProtectedHeader({ alg: 'ES256', kid: 'fixture' })
      .setIssuer('ownership-fixture').setAudience('karaka').setIssuedAt().setExpirationTime('2m').sign(keys.privateKey)
  }

  async function post(ctx: Context, method: string, chatId: string | undefined, body: object) {
    const response = await fetch(`http://127.0.0.1:${ctx.webServer.port}/browser/${method}`, {
      method: 'POST',
      headers: { origin: 'https://application.test', authorization: `Bearer ${await token(chatId)}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const value: unknown = await response.json()
    return { status: response.status, body: value }
  }

  const chatId = SessionId('application-chat')
  const first = await boot(1)
  const creation = await post(first, 'applicationCreate', chatId, { chatId, agentId: 'application' })
  expect(creation.status).toBe(200)
  expect(creation).toMatchInlineSnapshot(`
    {
      "body": {
        "ok": true,
        "value": {
          "agentId": "application",
          "chatId": "application-chat",
        },
      },
      "status": 200,
    }
  `)
  expect(first.ownershipProbe.published).toEqual([{ chatId, owner }])
  const reply = Promise.withResolvers<undefined>()
  first.on('session/event', (session, event) => {
    if (session.id === chatId && event.type === 'assistant/message') reply.resolve(undefined)
  }, { global: true })
  const prompted = await post(first, 'applicationPrompt', chatId, {
    chatId, requestId: 'initial-prompt', content: [{ type: 'text', text: 'Keep this message after restart.' }],
  })
  expect(prompted.status).toBe(200)
  expect(prompted).toMatchInlineSnapshot(`
    {
      "body": {
        "ok": true,
        "value": {
          "accepted": true,
          "duplicate": false,
        },
      },
      "status": 200,
    }
  `)
  await reply.promise
  const agent = first.agents.get(chatId)
  expect(agent).toBeDefined()
  await agent?.whenIdle()
  await first.sessionPersistence.flush()
  await first.karakaApplication.create({ chatId: SessionId('background-chat'), agentId: 'background', owner })
  const childId = SessionId('child-chat')
  const child = Session.create(childId, [], { ...Session.create(childId).header, parentSession: chatId, agentPreset: 'application' })
  {
    await using childHandle = await first.sessionPersistence.create(child.header)
    await childHandle.flush()
  }
  await first.fiber.dispose()

  const second = await boot(2)
  expect(await second.karakaIdentity.ownerOfId(chatId)).toBeUndefined()
  expect(second.agents.get(chatId)).toBeUndefined()
  expect(await post(second, 'applicationHistory', undefined, { chatId })).toMatchInlineSnapshot(`
    {
      "body": {
        "code": "UNAUTHORIZED",
        "message": "Invalid browser credential",
      },
      "status": 401,
    }
  `)
  expect(await post(second, 'applicationHistory', chatId, { chatId: 'background-chat' })).toMatchInlineSnapshot(`
    {
      "body": {
        "error": {
          "code": "gateway/forbidden",
          "details": {},
          "message": "Chat access is forbidden",
        },
        "ok": false,
      },
      "status": 403,
    }
  `)
  for (const denied of ['background-chat', childId]) {
    expect(await post(second, 'applicationHistory', denied, { chatId: denied })).toMatchInlineSnapshot(`
      {
        "body": {
          "error": {
            "code": "gateway/forbidden",
            "details": {},
            "message": "Chat access is forbidden",
          },
          "ok": false,
        },
        "status": 403,
      }
    `)
    expect(await second.karakaIdentity.ownerOfId(SessionId(denied))).toBeUndefined()
  }
  expect(await post(second, 'applicationCreate', 'uncreated-chat', {
    chatId: 'uncreated-chat', agentId: 'background',
  })).toMatchInlineSnapshot(`
    {
      "body": {
        "error": {
          "code": "gateway/forbidden",
          "details": {},
          "message": "Chat access is forbidden",
        },
        "ok": false,
      },
      "status": 403,
    }
  `)
  expect(await second.sessionPersistence.stat(SessionId('uncreated-chat'))).toBeUndefined()
  expect(await second.karakaIdentity.ownerOfId(chatId)).toBeUndefined()

  const history = await post(second, 'applicationHistory', chatId, { chatId })
  expect(history.status).toBe(200)
  expect(history.body).toMatchObject({ ok: true })
  const serializedHistory = JSON.stringify(history.body)
  expect(serializedHistory).toContain('"type":"user/message"')
  expect(serializedHistory).toContain('Keep this message after restart.')
  expect(serializedHistory).toContain('"type":"assistant/message"')
  expect(serializedHistory).toContain('Recorded ownership reply.')
  expect(await second.karakaIdentity.ownerOfId(chatId)).toEqual(owner)
  expect(second.agents.get(chatId)).toBeUndefined()
  expect(second.sessions.get(chatId)).toBeUndefined()
  expect(second.ownershipProbe.published).toEqual([])
  expect(await post(second, 'applicationCreate', chatId, { chatId, agentId: 'application' })).toMatchInlineSnapshot(`
    {
      "body": {
        "ok": true,
        "value": {
          "agentId": "application",
          "chatId": "application-chat",
        },
      },
      "status": 200,
    }
  `)
  expect(second.ownershipProbe.published).toEqual([{ chatId, owner }])
  expect((await readdir(root)).sort()).toEqual(['boot-1.yml', 'boot-2.yml', 'sessions'])
})
