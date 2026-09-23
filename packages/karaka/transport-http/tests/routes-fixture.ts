import { once } from 'node:events'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { ServerAuth, type AuthenticatedApplication } from '@karaka-ai/server-auth'
import { BrowserAuthentication, type BrowserCaller } from '@karaka-ai/browser-auth'
import { ApplicationId } from '@karaka-ai/identity'
import { onTestFinished, vi, type Mock, type MockInstance } from 'vitest'
import { apply, type Config } from '../src/index.ts'
import type { ApplicationChatController, FollowFrame } from '../src/application.ts'
import { applicationFixture, owner } from './application-fixture.ts'

type RoutesFixture = Omit<Awaited<ReturnType<typeof applicationFixture>>, 'events'> & {
  routes: WebRoute[]
  request: (path: string, body?: unknown, init?: RequestInit) => Promise<Response>
  markReady: () => void
  authenticate: Mock<() => Promise<AuthenticatedApplication | undefined>>
  browserAuthenticate: Mock<() => Promise<BrowserCaller | undefined>>
  removeBrowserAuth: () => void
  listAgents: MockInstance<ApplicationChatController['listAgents']>
  create: MockInstance<ApplicationChatController['create']>
  prompt: MockInstance<ApplicationChatController['prompt']>
  cancel: MockInstance<ApplicationChatController['cancel']>
  selectModel: MockInstance<ApplicationChatController['selectModel']>
  events: MockInstance<ApplicationChatController['events']>
  follow: MockInstance<ApplicationChatController['follow']>
  snapshot: Extract<FollowFrame, { type: 'snapshot' }>
}

export async function fixture(config: Config = { path: '/api', handleQuestions: false }, ready = true): Promise<RoutesFixture> {
  const state = await applicationFixture(false)
  const { ctx } = state
  const routes: WebRoute[] = []
  const webServer = {
    register: (route: WebRoute) => {
      routes.push(route)
      return () => { const index = routes.indexOf(route); if (index >= 0) routes.splice(index, 1) }
    },
  }
  ctx.provide('webServer', Object.setPrototypeOf(webServer, WebServer.prototype) as WebServer)
  ctx.provide('karakaStartup', { get ready() { return ready } })
  const authenticate = vi.fn(async (): Promise<AuthenticatedApplication | undefined> => ({ applicationId: ApplicationId('app') }))
  const serverAuth = { authenticate }
  ctx.provide('serverAuth', Object.setPrototypeOf(serverAuth, ServerAuth.prototype) as ServerAuth)
  const browserAuthenticate = vi.fn(async (): Promise<BrowserCaller | undefined> => ({ kind: 'application' as const, owner, expiresAt: Date.now() + 60_000 }))
  const browserAuth = { authenticate: browserAuthenticate }
  const removeBrowserAuth = ctx.provide('karakaBrowserAuth', Object.setPrototypeOf(browserAuth, BrowserAuthentication.prototype) as BrowserAuthentication)
  apply(ctx, config)
  const app = ctx.karakaApplication
  const listAgents = vi.spyOn(app, 'listAgents').mockResolvedValue([{ id: 'main', name: 'Main' }])
  const create = vi.spyOn(app, 'create').mockImplementation(async request => ({ chatId: request.chatId, agentId: request.agentId }))
  const prompt = vi.spyOn(app, 'prompt').mockResolvedValue({ accepted: true, duplicate: false })
  const cancel = vi.spyOn(app, 'cancel').mockResolvedValue({ accepted: true })
  const selectModel = vi.spyOn(app, 'selectModel').mockResolvedValue({ selected: { provider: 'mock', model: 'chat' } })
  const events = vi.spyOn(app, 'events').mockResolvedValue([])
  const snapshot: FollowFrame = {
    type: 'snapshot', header: Session.create(SessionId('chat')).header, hasMore: false,
    projections: { asOfSeq: -1, values: {} }, cursor: -1, records: [],
  }
  const follow = vi.spyOn(app, 'follow').mockImplementation(async function* () { yield snapshot })
  const server = createServer((request, response) => {
    const route = routes.find(candidate => request.url?.startsWith(candidate.path))
    if (route === undefined) { response.writeHead(404).end(); return }
    void Promise.resolve(route.handler(request, response)).catch((error: unknown) => {
      response.destroy(error instanceof Error ? error : undefined)
    })
  })
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((error) => {
      if (error === undefined) resolve()
      else reject(error)
    }))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address() as AddressInfo
  const base = `http://127.0.0.1:${address.port}`
  async function request(path: string, body?: unknown, init: RequestInit = {}) {
    return fetch(`${base}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: 'Bearer accepted', 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...init,
    })
  }
  return { ...state, routes, request, markReady: () => { ready = true }, authenticate, browserAuthenticate, removeBrowserAuth,
    listAgents, create, prompt, cancel, selectModel, events, follow, snapshot }
}

export const identity = { tenantId: 'tenant', userId: 'user' }
export const browser = { path: '/api', handleQuestions: false, browserPath: '/browser', browserOrigins: ['https://app.example'] }
export const browserHeaders = { origin: 'https://app.example', authorization: 'Bearer signed', 'content-type': 'application/json' }
