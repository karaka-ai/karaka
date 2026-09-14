import { expect, it, onTestFinished, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { scopeTarget } from '@deepseek-ai/dsh-scope'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type { AskUserQuestionAnswer } from '@deepseek-ai/dsh-user-questions/types'
import { UserId } from '@karaka-ai/identity'
import { fixture, browser, browserHeaders, identity } from './routes-fixture.ts'
import { owner } from './application-fixture.ts'

const questions = [{ id: 'choice', question: 'Continue?', options: [{ label: 'Yes' }] }]
const answer: AskUserQuestionAnswer = { answers: [{ id: 'choice', selected: ['Yes'], custom: 'Proceed' }] }

async function interactionFixture(browserEnabled = true) {
  const state = await fixture(browserEnabled ? browser : { path: '/api', handleQuestions: true })
  const { agent } = await state.factory.createAgent(state.ctx, { sessionId: SessionId('chat') })
  state.owners.set(agent.id, owner)
  const fallback = vi.fn(() => Promise.resolve<AskUserQuestionAnswer>({ answers: [] }))
  const ask = (signal?: AbortSignal) => state.ctx.waterfall(
    scopeTarget(agent, agent), 'user-questions/request',
    { agent, questions, ...(signal === undefined ? {} : { signal }) }, fallback,
  )
  const approve = (signal?: AbortSignal) => state.ctx.waterfall(
    scopeTarget(agent, agent), 'approval/request',
    { agent, toolName: 'bash', reason: 'Run command', ...(signal === undefined ? {} : { signal }) },
    () => Promise.resolve<ApprovalOutcome>('unavailable'),
  )
  return { ...state, agent, ask, approve, fallback }
}

async function stream(response: Response) {
  expect(response.status).toBe(200)
  if (response.body === null) throw new Error('Expected SSE response body')
  const reader = response.body.getReader()
  onTestFinished(async () => { await reader.cancel() })
  const decoder = new TextDecoder()
  let buffer = ''
  async function next(): Promise<Record<string, unknown>> {
    while (true) {
      const end = buffer.indexOf('\n\n')
      if (end >= 0) {
        const frame = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5)).join('\n')
        return JSON.parse(data) as Record<string, unknown>
      }
      const chunk = await reader.read()
      if (chunk.done) throw new Error('SSE ended before the expected event')
      buffer += decoder.decode(chunk.value, { stream: true })
    }
  }
  return { next, close: () => reader.cancel() }
}

async function browserChannel(state: Awaited<ReturnType<typeof fixture>>) {
  const channel = await stream(await state.request('/browser/events', {}, { headers: browserHeaders }))
  const ready = await channel.next()
  expect(ready.type).toBe('ready')
  expect(ready.clientId).toBeTypeOf('string')
  return { ...channel, clientId: ready.clientId }
}

it('accepts an owner approval and denies foreign, invalid, and stale replies', async () => {
  const state = await interactionFixture()
  const channel = await browserChannel(state)
  const pending = state.approve()
  const event = await channel.next()
  expect(event).toMatchObject({
    type: 'interaction', chatId: 'chat', event: 'approval/request',
    request: { agent: { id: 'chat' }, toolName: 'bash', reason: 'Run command' },
  })
  const reply = { clientId: channel.clientId, eventId: event.eventId, outcome: { kind: 'result', value: 'allowed-once' } }
  state.browserAuthenticate.mockResolvedValueOnce({
    kind: 'application', owner: { ...owner, userId: UserId('foreign') }, expiresAt: Date.now() + 60_000,
  })
  expect((await state.request('/browser/result', reply, { headers: browserHeaders })).status).toBe(403)
  expect((await state.request('/browser/result', { ...reply, clientId: 'missing' }, { headers: browserHeaders })).status).toBe(403)
  expect((await state.request('/browser/result', {
    ...reply, outcome: { kind: 'result', value: 'invalid' },
  }, { headers: browserHeaders })).status).toBe(400)
  expect((await state.request('/browser/result', reply, { headers: browserHeaders })).status).toBe(200)
  await expect(pending).resolves.toBe('allowed-once')
  expect(await channel.next()).toEqual({ type: 'cancel', eventId: event.eventId })
  expect((await state.request('/browser/result', reply, { headers: browserHeaders })).status).toBe(403)
})

it('keeps a question pending until every recipient delegates', async () => {
  const state = await interactionFixture()
  const first = await browserChannel(state)
  const second = await browserChannel(state)
  const pending = state.ask()
  const event = await first.next()
  expect(await second.next()).toEqual(event)
  for (const channel of [first, second]) {
    expect(state.fallback).not.toHaveBeenCalled()
    const reply = { clientId: channel.clientId, eventId: event.eventId, outcome: { kind: 'next' } }
    expect((await state.request('/browser/result', reply, { headers: browserHeaders })).status).toBe(200)
  }
  await expect(pending).resolves.toEqual({ answers: [] })
  expect(state.fallback).toHaveBeenCalledOnce()
  expect(await first.next()).toEqual({ type: 'cancel', eventId: event.eventId })
  expect(await second.next()).toEqual({ type: 'cancel', eventId: event.eventId })
})

it('delivers concurrent approvals only to their respective owners', async () => {
  const state = await interactionFixture()
  const local = await browserChannel(state)
  const localResult = state.approve()
  const localEvent = await local.next()
  const foreignOwner = { ...owner, userId: UserId('foreign') }
  state.browserAuthenticate.mockResolvedValueOnce({
    kind: 'application', owner: foreignOwner, expiresAt: Date.now() + 60_000,
  })
  const foreign = await browserChannel(state)
  const { agent } = await state.factory.createAgent(state.ctx, { sessionId: SessionId('foreign-chat') })
  state.owners.set(agent.id, foreignOwner)
  const foreignResult = state.ctx.waterfall(scopeTarget(agent, agent), 'approval/request', {
    agent, toolName: 'read', callId: ToolCallId('call'),
  }, () => Promise.resolve<ApprovalOutcome>('unavailable'))
  const foreignEvent = await foreign.next()
  expect(localEvent.chatId).toBe('chat')
  expect(foreignEvent).toMatchObject({
    chatId: 'foreign-chat', request: { agent: { id: 'foreign-chat' }, toolName: 'read', callId: 'call' },
  })
  const reply = { clientId: local.clientId, eventId: foreignEvent.eventId, outcome: { kind: 'result', value: 'rejected' } }
  expect((await state.request('/browser/result', reply, { headers: browserHeaders })).status).toBe(403)
  expect((await state.request('/browser/result', {
    ...reply, eventId: localEvent.eventId,
  }, { headers: browserHeaders })).status).toBe(200)
  state.browserAuthenticate.mockResolvedValueOnce({
    kind: 'application', owner: foreignOwner, expiresAt: Date.now() + 60_000,
  })
  expect((await state.request('/browser/result', {
    ...reply, clientId: foreign.clientId,
  }, { headers: browserHeaders })).status).toBe(200)
  await expect(localResult).resolves.toBe('rejected')
  await expect(foreignResult).resolves.toBe('rejected')
  expect(await local.next()).toEqual({ type: 'cancel', eventId: localEvent.eventId })
  expect(await foreign.next()).toEqual({ type: 'cancel', eventId: foreignEvent.eventId })
})

it('replays a pending question to a reconnected owner and validates answer fields', async () => {
  const state = await interactionFixture()
  const original = await browserChannel(state)
  const pending = state.ask()
  const event = await original.next()
  await original.close()
  const reconnected = await browserChannel(state)
  expect(await reconnected.next()).toEqual(event)
  const reply = { clientId: reconnected.clientId, eventId: event.eventId, outcome: { kind: 'result', value: answer } }
  expect((await state.request('/browser/result', {
    ...reply, outcome: { kind: 'result', value: { answers: [{ id: 'choice', selected: 'Yes' }] } },
  }, { headers: browserHeaders })).status).toBe(400)
  expect((await state.request('/browser/result', reply, { headers: browserHeaders })).status).toBe(200)
  await expect(pending).resolves.toEqual(answer)
  expect(state.fallback).not.toHaveBeenCalled()
  expect(await reconnected.next()).toEqual({ type: 'cancel', eventId: event.eventId })
})

it('cancels a live browser interaction and rejects pending work on disposal', async () => {
  const state = await interactionFixture()
  const channel = await browserChannel(state)
  const controller = new AbortController()
  const pending = state.ask(controller.signal)
  const rejected = expect(pending).rejects.toThrow('caller cancelled')
  const event = await channel.next()
  controller.abort(new Error('caller cancelled'))
  await rejected
  expect(await channel.next()).toEqual({ type: 'cancel', eventId: event.eventId })
  const approval = state.approve()
  const disposed = expect(approval).rejects.toThrow('Browser transport disposed')
  await channel.next()
  await channel.close()
  await state.ctx.fiber.dispose()
  await disposed
})

it('delegates unowned and agentless requests and requests without browser recipients', async () => {
  const state = await interactionFixture()
  await expect(state.ask()).resolves.toEqual({ answers: [] })
  await expect(state.approve()).resolves.toBe('unavailable')
  await browserChannel(state)
  state.owners.clear()
  await expect(state.ask()).resolves.toEqual({ answers: [] })
  await expect(state.approve()).resolves.toBe('unavailable')
  await expect(state.ctx.waterfall('user-questions/request', { questions }, state.fallback))
    .resolves.toEqual({ answers: [] })
  expect(state.fallback).toHaveBeenCalledTimes(3)
})

it('rejects a pre-cancelled browser request and retracts the published interaction', async () => {
  const state = await interactionFixture()
  const channel = await browserChannel(state)
  await expect(state.ask(AbortSignal.abort(new Error('already cancelled')))).rejects.toThrow('already cancelled')
  const event = await channel.next()
  expect(event.type).toBe('interaction')
  expect(await channel.next()).toEqual({ type: 'cancel', eventId: event.eventId })
})

it.each([true, false])('reports cancellation without a reason (browser=%s)', async (browserEnabled) => {
  const state = await interactionFixture(browserEnabled)
  if (browserEnabled) await browserChannel(state)
  await expect(state.ask(AbortSignal.abort(null))).rejects.toThrow(
    browserEnabled ? 'Interaction cancelled' : 'Interaction was cancelled',
  )
})

it('delivers live backend questions, rejects foreign replies, and settles each reply once', async () => {
  const state = await interactionFixture(false)
  const stopped = Promise.withResolvers<undefined>()
  state.follow.mockImplementation(async function* (_request, signal) {
    try {
      yield state.snapshot
      if (!signal.aborted) await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => { resolve() }, { once: true })
      })
    } finally { stopped.resolve(undefined) }
  })
  const channel = await stream(await state.request('/api/chats/chat/stream', identity))
  expect(await channel.next()).toMatchObject({ type: 'snapshot' })
  const pending = state.ask()
  const event = await channel.next()
  expect(event).toMatchObject({ type: 'interaction-required', questions })
  const reply = { ...identity, interactionId: event.interactionId, answers: answer }
  expect((await state.request('/api/chats/chat/responses', { ...reply, userId: 'foreign' })).status).toBe(403)
  expect((await state.request('/api/chats/other/responses', reply)).status).toBe(403)
  expect((await state.request('/api/chats/chat/responses', reply)).status).toBe(200)
  await expect(pending).resolves.toEqual(answer)
  expect((await state.request('/api/chats/chat/responses', reply)).status).toBe(403)
  await channel.close()
  await stopped.promise
})

it('rejects pending backend questions and closes their active streams during disposal', async () => {
  const state = await interactionFixture(false)
  const stopped = Promise.withResolvers<undefined>()
  state.follow.mockImplementation(async function* (_request, signal) {
    try {
      yield state.snapshot
      if (!signal.aborted) await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => { resolve() }, { once: true })
      })
    } finally { stopped.resolve(undefined) }
  })
  const channel = await stream(await state.request('/api/chats/chat/stream', identity))
  await channel.next()
  const pending = state.ask()
  const rejected = expect(pending).rejects.toThrow('Karaka HTTP transport was disposed')
  await channel.next()
  await state.ctx.fiber.dispose()
  await rejected
  await stopped.promise
})

it('delivers a question after its durable event even while text deltas arrive', async () => {
  const state = await interactionFixture(false)
  const advance = Promise.withResolvers<undefined>()
  onTestFinished(() => { advance.resolve(undefined) })
  const durable = state.agent.session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'Continue' }], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  state.follow.mockImplementation(async function* () {
    yield state.snapshot
    await advance.promise
    yield { type: 'text-delta', cursor: -1, text: 'Thinking' }
    yield { type: 'event', event: durable }
  })
  const channel = await stream(await state.request('/api/chats/chat/stream', identity))
  await channel.next()
  const pending = state.ask()
  // A completed HTTP request places the asynchronous owner lookup before stream advancement.
  await state.request('/api/agents')
  advance.resolve(undefined)
  expect(await channel.next()).toMatchObject({ type: 'text-delta', text: 'Thinking' })
  expect(await channel.next()).toMatchObject({ type: 'user-message', cursor: durable.seq })
  const event = await channel.next()
  expect(event).toMatchObject({ type: 'interaction-required', cursor: durable.seq })
  const value = { answers: [{ id: 'choice', selected: ['Yes'] }] }
  expect((await state.request('/api/chats/chat/responses', {
    ...identity, interactionId: event.interactionId, answers: value,
  })).status).toBe(200)
  await expect(pending).resolves.toEqual(value)
})

it('replays unanswered backend questions and rejects them when their caller cancels', async () => {
  const state = await interactionFixture(false)
  const controller = new AbortController()
  const pending = state.ask(controller.signal)
  const rejected = expect(pending).rejects.toThrow('question cancelled')
  const channel = await stream(await state.request('/api/chats/chat/stream', identity))
  expect(await channel.next()).toMatchObject({ type: 'snapshot' })
  const event = await channel.next()
  expect(event).toMatchObject({ type: 'interaction-required', questions })
  controller.abort(new Error('question cancelled'))
  await rejected
  expect((await state.request('/api/chats/chat/responses', {
    ...identity, interactionId: event.interactionId, answers: answer,
  })).status).toBe(403)
  await expect(state.ask(AbortSignal.abort(new Error('pre-cancelled')))).rejects.toThrow('pre-cancelled')
  state.owners.clear()
  await expect(state.ask()).resolves.toEqual({ answers: [] })
  await expect(state.ctx.waterfall('user-questions/request', { questions }, state.fallback))
    .resolves.toEqual({ answers: [] })
})

it('isolates pending backend questions while preserving a second subscriber after disconnect', async () => {
  const state = await interactionFixture(false)
  const stopped = new Map<number, PromiseWithResolvers<undefined>>()
  let opened = 0
  state.follow.mockImplementation(async function* (_request, signal) {
    const index = ++opened
    const done = Promise.withResolvers<undefined>()
    stopped.set(index, done)
    try {
      yield state.snapshot
      if (!signal.aborted) await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => { resolve() }, { once: true })
      })
    } finally { done.resolve(undefined) }
  })
  const foreign = await state.factory.createAgent(state.ctx, { sessionId: SessionId('foreign-chat') })
  state.owners.set(foreign.agent.id, { ...owner, userId: UserId('foreign') })
  const cancelForeign = new AbortController()
  const pendingForeign = state.ctx.waterfall(scopeTarget(foreign.agent, foreign.agent), 'user-questions/request', {
    agent: foreign.agent, questions, signal: cancelForeign.signal,
  }, state.fallback)
  const foreignRejected = expect(pendingForeign).rejects.toThrow('foreign finished')
  const first = await stream(await state.request('/api/chats/chat/stream', identity))
  expect(await first.next()).toMatchObject({ type: 'snapshot' })
  const second = await stream(await state.request('/api/chats/chat/stream', identity))
  expect(await second.next()).toMatchObject({ type: 'snapshot' })
  await first.close()
  await stopped.get(1)?.promise
  const pending = state.ask()
  const event = await second.next()
  expect(event).toMatchObject({ type: 'interaction-required', questions })
  expect((await state.request('/api/chats/chat/responses', {
    ...identity, interactionId: event.interactionId, answers: answer,
  })).status).toBe(200)
  await expect(pending).resolves.toEqual(answer)
  cancelForeign.abort(new Error('foreign finished'))
  await foreignRejected
  await second.close()
  await stopped.get(2)?.promise
})
