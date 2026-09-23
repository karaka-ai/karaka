import { expect, it } from 'vitest'
import { KARAKA_APPLICATION_API_PATH } from '@karaka-ai/sdk'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createMessage, createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import { applicationFixture, owner } from './application-fixture.ts'
import { mountBrowserRoutes } from '../src/browser-routes.ts'
import { fixture, identity, browser, browserHeaders } from './routes-fixture.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    fixture: { kind: 'fixture' } & ContextFormed
  }
}

it('holds routes until launcher readiness and rejects invalid server credentials', async () => {
  const state = await fixture(undefined, false)
  expect((await state.request('/api/agents')).status).toBe(503)
  state.markReady()
  expect((await state.request('/api/agents')).status).toBe(200)
  state.authenticate.mockResolvedValueOnce(undefined)
  expect((await state.request('/api/agents')).status).toBe(401)
  expect((await state.request('/api/missing')).status).toBe(404)
})

it('maps backend operations to authenticated application ownership', async () => {
  const state = await fixture()
  expect((await state.request('/api/chats', { ...identity, chatId: 'chat', agentId: 'main' })).status).toBe(201)
  expect(state.create).toHaveBeenCalledWith({ chatId: 'chat', agentId: 'main', owner }, expect.any(AbortSignal))
  const content = [{ type: 'text', text: 'hello' }, { type: 'image', mediaType: 'image/png', data: 'eA==', name: 'image.png' }]
  expect((await state.request('/api/chats/chat/messages', { ...identity, requestId: 'request', content })).status).toBe(202)
  expect(state.prompt).toHaveBeenCalledWith({ chatId: 'chat', owner, requestId: 'request', content }, expect.any(AbortSignal))
  expect((await state.request('/api/chats/chat/history', identity)).status).toBe(200)
  expect((await state.request('/api/chats/chat/cancel', identity)).status).toBe(200)
  expect((await state.request('/api/chats/chat/model', { ...identity, provider: 'mock', model: 'chat', reasoningEffort: 'high' })).status).toBe(200)
  expect(state.selectModel).toHaveBeenCalledWith({ chatId: 'chat', owner, provider: 'mock', model: 'chat', reasoningEffort: 'high' }, expect.any(AbortSignal))
  expect((await state.request('/api/chats/chat/responses', { ...identity, interactionId: 'missing', answers: { answers: [] } })).status).toBe(403)
})

it.each([
  ['forbidden', 403, 'CHAT_FORBIDDEN'], ['unavailable', 503, 'CHAT_UNAVAILABLE'],
  ['CHAT_FORBIDDEN', 403, 'CHAT_FORBIDDEN'], ['SESSION_QUERY_SESSION_NOT_FOUND', 404, 'CHAT_NOT_FOUND'],
  ['session/not-found', 404, 'CHAT_NOT_FOUND'], ['agent-preset/not-found', 404, 'AGENT_NOT_FOUND'],
  ['session/conflict', 409, 'CHAT_CONFLICT'], ['agent-preset/conflict', 409, 'CHAT_CONFLICT'],
  ['session/agent-busy', 409, 'CHAT_CONFLICT'], ['BAD_REQUEST', 400, 'BAD_REQUEST'],
  ['gateway/bad-request', 400, 'BAD_REQUEST'], ['session/model-unavailable', 400, 'BAD_REQUEST'],
  ['session/attachment-invalid', 400, 'BAD_REQUEST'], ['agent-preset/invalid', 400, 'BAD_REQUEST'],
  ['unexpected', 500, 'INTERNAL_ERROR'],
])('exposes %s without leaking backend error messages', async (code, status, exposed) => {
  const state = await fixture()
  state.listAgents.mockRejectedValueOnce(Object.assign(new Error('private credential'), { code }))
  const response = await state.request('/api/agents')
  expect(response.status).toBe(status)
  const body = await response.text()
  expect(body).toContain(exposed)
  expect(body).not.toContain('private credential')
})

it('rejects invalid request bodies and malformed path escapes', async () => {
  const state = await fixture({ path: '/api', maxBodyBytes: 128, handleQuestions: false })
  expect((await state.request('/api/chats', {})).status).toBe(400)
  expect((await state.request('/api/chats/%FF/history', identity)).status).toBe(500)
  expect((await state.request('/api/chats', { large: 'x'.repeat(200) })).status).toBe(400)
  state.listAgents.mockRejectedValueOnce('private string')
  expect((await state.request('/api/agents')).status).toBe(500)
})

it('opens a snapshot-first SSE stream, validates its cursor, and closes a completed iterator', async () => {
  const state = await fixture()
  const response = await state.request('/api/chats/chat/stream', identity)
  expect(response.headers.get('content-type')).toContain('text/event-stream')
  expect(await response.text()).toContain('"type":"snapshot","cursor":-1')
  expect((await state.request('/api/chats/chat/stream', { ...identity, cursor: 5 })).status).toBe(400)
  state.follow.mockImplementationOnce(async function* () {})
  expect((await state.request('/api/chats/chat/stream', identity)).status).toBe(500)
  state.follow.mockImplementationOnce(async function* () { yield { type: 'text-delta', cursor: 0, text: 'no snapshot' } })
  expect((await state.request('/api/chats/chat/stream', identity)).status).toBe(500)
  state.follow.mockImplementationOnce(async function* () { yield state.snapshot; yield { type: 'text-delta', cursor: -1, text: 'streamed' }; throw new Error('private stream error') })
  const failed = await state.request('/api/chats/chat/stream', identity)
  const body = await failed.text()
  expect(body).toContain('streamed')
  expect(body).toContain('INTERNAL_ERROR')
  expect(body).not.toContain('private stream error')
})

it('enforces browser origins, preflight, credentials, and POST-only methods', async () => {
  const state = await fixture(browser)
  expect((await state.request('/browser/applicationAgents', {})).status).toBe(403)
  expect((await state.request('/browser/applicationAgents', undefined, { method: 'OPTIONS', headers: browserHeaders })).status).toBe(204)
  expect((await state.request('/browser/applicationAgents', undefined, { headers: browserHeaders })).status).toBe(405)
  expect((await state.request('/browser/applicationAgents', {}, { headers: { origin: 'https://app.example' } })).status).toBe(401)
  state.browserAuthenticate.mockResolvedValueOnce(undefined)
  expect((await state.request('/browser/applicationAgents', {}, { headers: browserHeaders })).status).toBe(401)
  expect((await state.request('/browser/missing', {}, { headers: browserHeaders })).status).toBe(403)
  state.removeBrowserAuth()
  expect((await state.request('/browser/applicationAgents', {}, { headers: browserHeaders })).status).toBe(500)
})

it('derives browser operation owners from signed claims and refuses caller-supplied owner fields', async () => {
  const state = await fixture(browser)
  expect((await state.request('/browser/applicationAgents', {}, { headers: browserHeaders })).status).toBe(200)
  expect((await state.request('/browser/applicationCreate', { chatId: 'chat', agentId: 'main' }, { headers: browserHeaders })).status).toBe(200)
  expect(state.create).toHaveBeenCalledWith({ chatId: 'chat', agentId: 'main', owner }, expect.any(AbortSignal))
  expect((await state.request('/browser/applicationCreate', { chatId: 'chat', agentId: 'main', userId: 'foreign' }, { headers: browserHeaders })).status).toBe(400)
  expect((await state.request('/browser/applicationPrompt', { chatId: 'chat', requestId: 'r', content: [{ type: 'text', text: 'hi' }] }, { headers: browserHeaders })).status).toBe(200)
  expect((await state.request('/browser/applicationHistory', { chatId: 'chat' }, { headers: browserHeaders })).status).toBe(200)
  expect((await state.request('/browser/applicationCancel', { chatId: 'chat' }, { headers: browserHeaders })).status).toBe(200)
  expect((await state.request('/browser/applicationFollow', { chatId: 'chat' }, { headers: browserHeaders })).headers.get('content-type')).toContain('text/event-stream')
  expect((await state.request('/browser/result', { clientId: 'missing', eventId: 'missing', outcome: { kind: 'next' } }, { headers: browserHeaders })).status).toBe(403)
  state.events.mockRejectedValueOnce(Object.assign(new Error('foreign user'), { code: 'forbidden' }))
  expect((await state.request('/browser/applicationHistory', { chatId: 'chat' }, { headers: browserHeaders })).status).toBe(403)
})


it('rejects invalid or overlapping route prefixes', async () => {
  const { ctx } = await applicationFixture(false)
  expect(() => { mountBrowserRoutes(ctx, {}, () => true) }).not.toThrow()
  expect(() => { mountBrowserRoutes(ctx, { browserPath: '/browser' }, () => true) }).toThrow('requires explicit origins')
  expect(() => { mountBrowserRoutes(ctx, { browserPath: '/browser', browserOrigins: [] }, () => true) }).toThrow('requires explicit origins')
  for (const path of ['relative', '/', '/trailing/']) await expect(fixture({ path })).rejects.toThrow('path must start')
  await expect(fixture({ path: '/api', browserPath: '/browser' })).rejects.toThrow('requires explicit origins')
  await expect(fixture({ path: '/api', browserPath: '/browser', browserOrigins: [] })).rejects.toThrow('requires explicit origins')
  for (const browserPath of ['/api', '/api/browser', '/']) {
    await expect(fixture({ ...browser, browserPath })).rejects.toThrow()
  }
  await expect(fixture({ ...browser, path: '/browser/api' })).rejects.toThrow('must be disjoint')
})

it('holds browser methods until ready and encodes sanitized failures before and after streaming', async () => {
  const state = await fixture(browser, false)
  expect((await state.request('/browser/applicationAgents', {}, { headers: browserHeaders })).status).toBe(503)
  state.markReady()
  state.listAgents.mockRejectedValueOnce('private non-Error')
  expect((await state.request('/browser/applicationAgents', {}, { headers: browserHeaders })).status).toBe(500)
  const error = new Error('private implementation')
  delete error.stack
  state.listAgents.mockRejectedValueOnce(error)
  expect((await state.request('/browser/applicationAgents', {}, { headers: browserHeaders })).status).toBe(500)
  state.follow.mockImplementationOnce(async function* () {})
  expect((await state.request('/browser/applicationFollow', { chatId: 'chat' }, { headers: browserHeaders })).status).toBe(500)
  state.follow.mockImplementationOnce(async function* () {
    yield state.snapshot
    yield { type: 'text-delta', cursor: -1, text: 'hello' }
    throw new Error('private stream detail')
  })
  const response = await state.request('/browser/applicationFollow', { chatId: 'chat' }, { headers: browserHeaders })
  const body = await response.text()
  expect(body).toContain('hello')
  expect(body).toContain('gateway/internal')
  expect(body).not.toContain('private stream detail')
})

it('cancels an admitted backend operation when its HTTP client disconnects', async () => {
  const state = await fixture()
  const entered = Promise.withResolvers<undefined>()
  const cancelled = Promise.withResolvers<undefined>()
  state.listAgents.mockImplementationOnce(async (signal) => {
    entered.resolve(undefined)
    await new Promise<never>((_resolve, reject) => signal?.addEventListener('abort', () => {
      cancelled.resolve(undefined)
      reject(new Error('request cancelled'))
    }, { once: true }))
    return []
  })
  const controller = new AbortController()
  const pending = state.request('/api/agents', undefined, { signal: controller.signal })
  const rejected = expect(pending).rejects.toThrow()
  await entered.promise
  controller.abort()
  await rejected
  await cancelled.promise
})


it('projects current Session history and preserves cursor filtering for snapshot and live frames', async () => {
  const state = await fixture()
  const id = SessionId('recorded')
  const session = state.ctx.sessions.create(id)
  session.append('turn/start', { turn: 1 })
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'question' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'private prompt' }], source: { kind: 'fixture' } }), { surfaceOp: 'append' })
  session.append('assistant/message', { turn: 1, step: 1, stream: [], message: createMessage({
    role: 'assistant', content: [{ type: 'text', text: 'answer' }], source: { kind: 'model', provider: 'mock', model: 'chat' },
  }) }, { surfaceOp: 'append' })
  const callId = ToolCallId('call')
  session.append('tool/call', { turn: 1, step: 1, callId, name: 'echo', arguments: '{}' })
  session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId, content: [{ type: 'text', text: 'result' }], isError: false }) }, { surfaceOp: 'append' })
  const last = session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  const log = await state.ctx.sessionQuery.observeSession(id)
  try {
    state.events.mockResolvedValueOnce(log.events)
    const history = await (await state.request('/api/chats/recorded/history', identity)).text()
    expect(history).toContain('question')
    expect(history).toContain('assistant-message')
    expect(history).toContain('tool-call')
    expect(history).toContain('tool-result')
    expect(history).toContain('turn-end')
    expect(history).not.toContain('private prompt')
    const snapshot = { ...state.snapshot, header: session.header, cursor: last.seq, records: log.events.map(event => ({ type: 'event' as const, event })) }
    state.follow.mockImplementationOnce(async function* () { yield snapshot; yield { type: 'event', event: last } })
    const response = await state.request('/api/chats/recorded/stream', { ...identity, cursor: last.seq })
    const text = await response.text()
    expect(text).toContain('snapshot')
    expect(text).not.toContain('turn-end')
    state.follow.mockImplementationOnce(async function* () {
      yield state.snapshot
      for (const event of log.events) yield { type: 'event', event }
    })
    const live = await state.request('/api/chats/recorded/stream', identity)
    expect(await live.text()).toContain('turn-end')
  } finally {
    log[Symbol.dispose]()
  }
})


it('admits named and unnamed browser images and optional backend model effort', async () => {
  const state = await fixture({ ...browser, maxBodyBytes: 4096, browserEvents: [] })
  const images = [
    { type: 'image', mediaType: 'image/png', data: 'eA==' },
    { type: 'image', mediaType: 'image/png', data: 'eA==', name: 'named.png' },
  ]
  expect((await state.request('/browser/applicationPrompt', { chatId: 'chat', requestId: 'images', content: images }, { headers: browserHeaders })).status).toBe(200)
  expect(state.prompt).toHaveBeenCalledWith({ chatId: 'chat', requestId: 'images', content: images, owner }, expect.any(AbortSignal))
  expect((await state.request('/api/chats/chat/messages', { ...identity, requestId: 'images', content: images })).status).toBe(202)
  expect((await state.request('/api/chats/chat/model', { ...identity, provider: 'mock', model: 'chat' })).status).toBe(200)
})

it('handles an absent Node request URL without granting an implicit route', async () => {
  const state = await fixture(browser)
  for (const route of state.routes) {
    const handle = route.handler
    route.handler = (request, response) => {
      delete request.url
      return handle(request, response)
    }
  }
  expect((await state.request('/api/agents')).status).toBe(404)
  expect((await state.request('/browser/applicationAgents', {}, { headers: browserHeaders })).status).toBe(403)
})

it('expires an admitted browser operation and closes the response', async () => {
  const state = await fixture(browser)
  const cancelled = Promise.withResolvers<undefined>()
  state.browserAuthenticate.mockResolvedValueOnce({ kind: 'application', owner, expiresAt: 0 })
  state.listAgents.mockImplementationOnce(async (signal) => {
    if (signal === undefined) throw new Error('browser signal missing')
    await new Promise<never>((_resolve, reject) => {
      const abort = () => { cancelled.resolve(undefined); reject(new Error('expired')) }
      if (signal.aborted) abort()
      else signal.addEventListener('abort', abort, { once: true })
    })
    return []
  })
  await expect(state.request('/browser/applicationAgents', {}, { headers: browserHeaders })).rejects.toThrow()
  await cancelled.promise
})

it('projects records from repeated snapshots and validates an invalid opening frame', async () => {
  const state = await fixture()
  const session = state.ctx.sessions.create(SessionId('repeat'))
  const event = session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'snapshot content' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  state.follow.mockImplementationOnce(async function* () {
    yield state.snapshot
    yield { ...state.snapshot, header: session.header, cursor: event.seq, records: [{ type: 'event', event }] }
  })
  const response = await state.request('/api/chats/repeat/stream', identity)
  expect(await response.text()).toContain('snapshot content')
  state.follow.mockImplementationOnce(async function* () { yield { type: 'text-delta', cursor: 0, text: 'no snapshot' } })
  expect((await state.request('/api/chats/repeat/stream', identity)).status).toBe(500)
})


it('mounts the published backend path when no path override is configured', async () => {
  const state = await fixture({ handleQuestions: false })
  expect((await state.request(`${KARAKA_APPLICATION_API_PATH}/agents`)).status).toBe(200)
})
