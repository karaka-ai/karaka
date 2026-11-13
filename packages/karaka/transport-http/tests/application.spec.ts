import { expect, it, vi } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import { createUserMessage, LlmAttemptId } from '@deepseek-ai/dsh-llm'
import AttachmentStore from '@deepseek-ai/dsh-attachment'
import { UserId } from '@karaka-ai/identity'
import { applicationFixture, owner } from './application-fixture.ts'

const chatId = SessionId('chat')
const address = { chatId, owner }

async function fixture(browserAgentIds?: readonly string[]) {
  const state = await applicationFixture(true, browserAgentIds)
  if (state.controller === undefined) throw new Error('controller was not mounted')
  return { ...state, controller: state.controller }
}

it('lists usable presets and rejects pre-cancelled operations', async () => {
  const { controller, removePresets } = await fixture()
  expect(await controller.listAgents()).toEqual([{ id: 'main', name: 'Main' }, { id: 'plain', name: 'plain' }])
  const signal = AbortSignal.abort(new Error('cancelled'))
  await expect(controller.listAgents(signal)).rejects.toThrow('cancelled')
  await expect(controller.create({ ...address, agentId: 'main' }, signal)).rejects.toThrow('cancelled')
  await expect(controller.prompt({ ...address, requestId: 'r', content: [] }, signal)).rejects.toThrow('cancelled')
  await expect(controller.cancel(address, signal)).rejects.toThrow('cancelled')
  await expect(controller.selectModel({ ...address, provider: 'mock', model: 'chat' }, signal)).rejects.toThrow('cancelled')
  await expect(controller.events(address, signal)).rejects.toThrow('cancelled')
  removePresets()
  expect(await controller.listAgents()).toEqual([])
  await expect(controller.create({ ...address, agentId: 'main' })).rejects.toThrow('requires Agent presets')
})

it('binds before mounting a preset, acknowledges readiness, and deduplicates durable request ids', async () => {
  const { controller, identity, presets, followups, events } = await fixture()
  await expect(controller.create({ ...address, agentId: 'main' })).resolves.toEqual({ chatId, agentId: 'main' })
  expect(identity.bind.mock.invocationCallOrder[0]).toBeLessThan(presets.mount.mock.invocationCallOrder[0] ?? Infinity)
  const prompt = { ...address, requestId: 'request', content: [{ type: 'text' as const, text: 'hello' }] }
  expect(await controller.prompt(prompt)).toEqual({ accepted: true, duplicate: false })
  expect(await controller.prompt(prompt)).toEqual({ accepted: true, duplicate: true })
  expect(followups.get(chatId)).toHaveBeenCalledOnce()
  expect(events.get(chatId)?.some(event => event.type === 'user/message')).toBe(true)
  expect(await controller.create({ ...address, agentId: 'main' })).toEqual({ chatId, agentId: 'main' })
  await expect(controller.create({ ...address, agentId: 'different' })).rejects.toMatchObject({ code: 'session/conflict' })
})

it('denies foreign owners before resuming or reading a chat', async () => {
  const { controller, factory, observeSession } = await fixture()
  await controller.create({ ...address, agentId: 'main' })
  const foreign = { chatId, owner: { ...owner, userId: UserId('foreign') } }
  await expect(controller.cancel(foreign)).rejects.toMatchObject({ code: 'forbidden' })
  await expect(controller.events(foreign)).rejects.toMatchObject({ code: 'forbidden' })
  expect(factory.resume).not.toHaveBeenCalled()
  expect(observeSession).not.toHaveBeenCalled()
})

it('records model selection, keeps cancellation inbox semantics, and disposes observation leases', async () => {
  const { controller, cancellations, llm, observed, events } = await fixture()
  await controller.create({ ...address, agentId: 'main' })
  expect(await controller.selectModel({ ...address, provider: 'mock', model: 'next', reasoningEffort: 'high' }))
    .toEqual({ selected: { provider: 'mock', model: 'next', reasoningEffort: 'high' } })
  await controller.selectModel({ ...address, provider: 'mock', model: 'chat' })
  expect(llm.resolveCallConfig).toHaveBeenCalledTimes(2)
  expect(events.get(chatId)?.filter(event => event.type === 'model/selection')).toHaveLength(2)
  expect(await controller.cancel(address)).toEqual({ accepted: true })
  expect(cancellations.get(chatId)).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: true })
  expect(await controller.events(address)).toEqual(events.get(chatId))
  expect(observed).toHaveBeenCalledOnce()
})

it('rejects unavailable providers and image support before admitting a prompt', async () => {
  const { controller, llm, ctx, followups } = await fixture()
  await controller.create({ ...address, agentId: 'main' })
  const prompt = { ...address, requestId: 'image', content: [{ type: 'image' as const, mediaType: 'image/png' as const, data: 'eA==' }] }
  llm.listProviders.mockReturnValueOnce([])
  await expect(controller.prompt({ ...prompt, content: [] })).rejects.toMatchObject({ code: 'session/model-unavailable' })
  await expect(controller.prompt(prompt)).rejects.toMatchObject({ code: 'session/attachment-invalid' })
  const admitPromptContent = vi.fn(async () => [{ type: 'text' as const, text: 'admitted image' }])
  const attachments = { admitPromptContent }
  ctx.provide('attachments', Object.setPrototypeOf(attachments, AttachmentStore.prototype) as AttachmentStore)
  llm.resolveModelInfo.mockResolvedValueOnce({ inputModalities: ['text'] })
  await expect(controller.prompt(prompt)).rejects.toMatchObject({ code: 'session/attachment-invalid' })
  expect(followups.get(chatId)).not.toHaveBeenCalled()
  llm.resolveModelInfo.mockResolvedValueOnce({})
  await controller.prompt(prompt)
  expect(admitPromptContent).toHaveBeenCalledWith(prompt.content)
})

it('resumes an owned cold Agent with its recorded preset', async () => {
  const { controller, handles, factory, presets } = await fixture()
  await controller.create({ ...address, agentId: 'main' })
  await handles.get(chatId)?.dispose()
  await controller.cancel(address)
  expect(factory.resume).toHaveBeenCalledOnce()
  expect(presets.mount).toHaveBeenCalledTimes(2)
})

it('follows a snapshot and live events once, filters other chats, and closes on cancellation', async () => {
  const { controller, handles, ctx } = await fixture()
  await controller.create({ ...address, agentId: 'main' })
  const handle = handles.get(chatId)
  if (handle === undefined) throw new Error('missing chat')
  const abort = new AbortController()
  const stream = controller.follow(address, abort.signal)[Symbol.asyncIterator]()
  const snapshot = await stream.next()
  expect(snapshot.value).toMatchObject({ type: 'snapshot', cursor: handle.agent.session.seq - 1 })
  const pending = stream.next()
  const other = ctx.sessions.create(SessionId('other'))
  other.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'other' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  const event = handle.agent.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'owned' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  expect((await pending).value).toEqual({ type: 'event', event })
  agentEvents(ctx, handle.agent).emit('agent/assistant-stream', { frame: { type: 'chunk', attemptId: LlmAttemptId('attempt'), revision: 1, index: 0, time: 1, chunk: { type: 'text-delta', index: 0, text: 'live' } } })
  expect((await stream.next()).value).toMatchObject({ type: 'text-delta', text: 'live' })
  abort.abort()
  expect(await stream.next()).toEqual({ done: true, value: undefined })
})

it('ends open streams and disposes owned handles when its context closes', async () => {
  const { controller, disposals, ctx } = await fixture()
  await controller.create({ ...address, agentId: 'main' })
  const stream = controller.follow(address, new AbortController().signal)[Symbol.asyncIterator]()
  await stream.next()
  const pending = stream.next()
  await ctx.fiber.dispose()
  expect((await pending).done).toBe(true)
  expect(disposals.get(chatId)).toHaveBeenCalledOnce()
  await expect(controller.cancel(address)).rejects.toThrow('disposed')
})


it('rejects live Agents owned by another controller and cold Sessions without resolvable presets', async () => {
  const { controller, factory, ctx, owners, headers, removePresets } = await fixture()
  owners.set(chatId, owner)
  const outsider = await factory.createAgent(ctx, {
    sessionId: chatId, setup: async (_ctx, agent) => { headers.set(chatId, agent.session.header) },
  })
  await expect(controller.cancel(address)).rejects.toMatchObject({ code: 'session/conflict' })
  await outsider.dispose()
  removePresets()
  await expect(controller.cancel(address)).rejects.toThrow('no resolvable Agent preset')
})

it('rejects a cold Session lacking a preset even when a preset provider exists', async () => {
  const { controller, owners, headers } = await fixture()
  owners.set(chatId, owner)
  headers.set(chatId, Session.create(chatId).header)
  await expect(controller.cancel(address)).rejects.toThrow('no resolvable Agent preset')
})

it('retains preset descriptions while filtering broken entries', async () => {
  const { controller, presets } = await fixture()
  presets.list.mockResolvedValueOnce([{ id: 'named', name: 'Named', description: 'Useful agent' }])
  expect(await controller.listAgents()).toEqual([{ id: 'named', name: 'Named', description: 'Useful agent' }])
})

it('discards events and text already covered by the opening snapshot', async () => {
  const { controller, handles, ctx } = await fixture()
  await controller.create({ ...address, agentId: 'main' })
  const agent = handles.get(chatId)?.agent
  if (agent === undefined) throw new Error('missing chat')
  const original = controller.events.bind(controller)
  const observation = vi.spyOn(controller, 'events').mockImplementationOnce(async (request, signal) => {
    agentEvents(ctx, agent).emit('agent/assistant-stream', { frame: { type: 'chunk', attemptId: LlmAttemptId('attempt'), revision: 1, index: 0, time: 1, chunk: { type: 'text-delta', index: 0, text: 'old' } } })
    agent.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'baseline' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    return original(request, signal)
  })
  const abort = new AbortController()
  const stream = controller.follow(address, abort.signal)[Symbol.asyncIterator]()
  try {
    const initial = await stream.next()
    expect(initial.value).toMatchObject({ type: 'snapshot' })
    const next = stream.next()
    const template = agent.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'next' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    expect((await next).value).toEqual({ type: 'event', event: template })
    abort.abort()
    expect((await stream.next()).done).toBe(true)
  } finally {
    abort.abort()
    await stream.return?.()
    observation.mockRestore()
  }
})

it('rechecks ownership before publishing each live follow update', async () => {
  const { controller, handles, owners } = await fixture()
  await controller.create({ ...address, agentId: 'main' })
  const agent = handles.get(chatId)?.agent
  if (agent === undefined) throw new Error('missing chat')
  const stream = controller.follow(address, new AbortController().signal)[Symbol.asyncIterator]()
  await stream.next()
  owners.set(chatId, { ...owner, userId: UserId('foreign') })
  agent.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'private' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  await expect(stream.next()).rejects.toMatchObject({ code: 'forbidden' })
})


it('rejects a stream when its persisted snapshot omits an event before subscription', async () => {
  const { controller, handles } = await fixture()
  await controller.create({ ...address, agentId: 'main' })
  const agent = handles.get(chatId)?.agent
  if (agent === undefined) throw new Error('missing chat')
  agent.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'existing' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  const observation = vi.spyOn(controller, 'events').mockResolvedValueOnce([])
  const stream = controller.follow(address, new AbortController().signal)[Symbol.asyncIterator]()
  try {
    await stream.next()
    agent.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'later' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    await expect(stream.next()).rejects.toThrow('lost sequence continuity')
  } finally {
    await stream.return?.()
    observation.mockRestore()
  }
})


it('uses factory-owned model selection even when optional setup is omitted', async () => {
  const { controller, factory, headers, followups } = await fixture()
  const create = factory.createAgent.getMockImplementation()
  if (create === undefined) throw new Error('missing factory')
  factory.createAgent.mockImplementationOnce(async (ctx, options) => create(ctx, {
    ...options, setup: async (_ctx, agent) => { headers.set(agent.id, agent.session.header) },
  }))
  await controller.create({ ...address, agentId: 'main' })
  await controller.prompt({ ...address, requestId: 'r', content: [{ type: 'text', text: 'default model' }] })
  expect(followups.get(chatId)).toHaveBeenCalledOnce()
  await expect(controller.selectModel({ ...address, provider: 'mock', model: 'chat' })).resolves.toEqual({ selected: { provider: 'mock', model: 'chat' } })
})

it('uses the deployment default for an Agent without a recorded or configured model', async () => {
  const { controller, factory, handles, followups, llm, ctx } = await fixture()
  const create = factory.createAgent.getMockImplementation()
  if (create === undefined) throw new Error('missing factory')
  factory.createAgent.mockImplementationOnce((context, options) => create(context, { ...options, agentOptions: {} }))
  await controller.create({ ...address, agentId: 'main' })
  expect(handles.get(chatId)?.agent.model.current()).toBeUndefined()

  const currentSelection = vi.spyOn(ctx.agentDefaultModel, 'currentSelection')
  const prompt = { ...address, requestId: 'default-route', content: [{ type: 'text' as const, text: 'hello' }] }
  llm.listProviders.mockReturnValueOnce([{ id: 'other' }])
  await expect(controller.prompt(prompt)).rejects.toMatchObject({ code: 'session/model-unavailable' })
  expect(followups.get(chatId)).not.toHaveBeenCalled()
  await expect(controller.prompt(prompt)).resolves.toEqual({ accepted: true, duplicate: false })
  expect(currentSelection).toHaveBeenCalledTimes(2)
  expect(currentSelection).toHaveLastReturnedWith({ provider: 'mock', model: 'chat' })
  expect(followups.get(chatId)).toHaveBeenCalledOnce()
  expect(handles.get(chatId)?.agent.model.current()).toBeUndefined()
})

it('ignores non-text stream frames without exposing them to follow subscribers', async () => {
  const { controller, handles, ctx } = await fixture()
  await controller.create({ ...address, agentId: 'main' })
  const agent = handles.get(chatId)?.agent
  if (agent === undefined) throw new Error('missing chat')
  const cancel = new AbortController()
  const stream = controller.follow(address, cancel.signal)[Symbol.asyncIterator]()
  await stream.next()
  const next = stream.next()
  agentEvents(ctx, agent).emit('agent/assistant-stream', { frame: {
    type: 'start', attemptId: LlmAttemptId('attempt'), revision: 1, turn: 1, step: 1,
  } })
  agentEvents(ctx, agent).emit('agent/assistant-stream', { frame: {
    type: 'chunk', attemptId: LlmAttemptId('attempt'), revision: 1, index: 0, time: 1,
    chunk: { type: 'reasoning-delta', index: 0, text: 'private reasoning' },
  } })
  agentEvents(ctx, agent).emit('agent/assistant-stream', { frame: {
    type: 'chunk', attemptId: LlmAttemptId('attempt'), revision: 1, index: 1, time: 2,
    chunk: { type: 'text-delta', index: 0, text: 'visible' },
  } })
  expect((await next).value).toMatchObject({ type: 'text-delta', text: 'visible' })
  cancel.abort()
  await stream.return?.()
})

it('rejects mismatched signed chat and owner before recording ownership or activating an Agent', async () => {
  const { controller, identity, factory, observeSession } = await fixture()
  const caller = { kind: 'application' as const, chatId: SessionId('other'), owner, expiresAt: Date.now() + 60_000 }
  for (const browser of [caller, { ...caller, chatId, owner: { ...owner, userId: UserId('foreign') } }]) {
    const request = { ...address, browser }
    await expect(controller.create({ ...request, agentId: 'main' })).rejects.toMatchObject({ code: 'CHAT_FORBIDDEN' })
    await expect(controller.prompt({ ...request, requestId: 'r', content: [] })).rejects.toMatchObject({ code: 'CHAT_FORBIDDEN' })
    await expect(controller.cancel(request)).rejects.toMatchObject({ code: 'CHAT_FORBIDDEN' })
    await expect(controller.selectModel({ ...request, provider: 'mock', model: 'chat' })).rejects.toMatchObject({ code: 'CHAT_FORBIDDEN' })
    await expect(controller.events(request)).rejects.toMatchObject({ code: 'CHAT_FORBIDDEN' })
    await expect(controller.follow(request, new AbortController().signal)[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: 'CHAT_FORBIDDEN' })
  }
  expect(identity.reserve).not.toHaveBeenCalled()
  expect(identity.restore).not.toHaveBeenCalled()
  expect(factory.createAgent).not.toHaveBeenCalled()
  expect(factory.resume).not.toHaveBeenCalled()
  expect(observeSession).not.toHaveBeenCalled()
})

it('rejects browser presets and persisted child targets before ownership restoration', async () => {
  const { controller, headers, owners, identity, factory } = await fixture()
  const browser = { kind: 'application' as const, chatId, owner, expiresAt: Date.now() + 60_000 }
  const request = { ...address, browser }
  await expect(controller.create({ ...request, agentId: 'background' })).rejects.toMatchObject({ code: 'CHAT_FORBIDDEN' })
  for (const meta of [{ agentPreset: 'background' }, { agentPreset: 'main', parentSession: SessionId('root') }]) {
    headers.set(chatId, { ...Session.create(chatId).header, ...meta })
    await expect(controller.events(request)).rejects.toMatchObject({ code: 'CHAT_FORBIDDEN' })
    await expect(controller.create({ ...request, agentId: 'main' })).rejects.toMatchObject({ code: 'CHAT_FORBIDDEN' })
  }
  expect(owners.size).toBe(0)
  expect(identity.reserve).not.toHaveBeenCalled()
  expect(identity.restore).not.toHaveBeenCalled()
  expect(factory.createAgent).not.toHaveBeenCalled()
  expect(factory.resume).not.toHaveBeenCalled()
})

it.each([false, true])('restores a cold root for authorized history without creating an Agent (browser=%s)', async (browserAccess) => {
  const { controller, headers, owners, identity, factory, ctx } = await fixture()
  headers.set(chatId, { ...Session.create(chatId).header, agentPreset: 'main' })
  const browser = { kind: 'application' as const, chatId, owner, expiresAt: Date.now() + 60_000 }
  const request = { ...address, ...(browserAccess ? { browser } : {}) }
  if (browserAccess) {
    await expect(controller.authorizeBrowser(request, browser)).resolves.toMatchObject({ id: chatId })
    expect(owners.size).toBe(0)
  }
  expect(await controller.events(request)).toEqual([])
  expect(identity.restore).toHaveBeenCalledExactlyOnceWith(chatId, owner)
  expect(owners.get(chatId)).toEqual(owner)
  expect(ctx.sessions.get(chatId)).toBeUndefined()
  expect(factory.createAgent).not.toHaveBeenCalled()
  expect(factory.resume).not.toHaveBeenCalled()
  const stream = controller.follow(request, new AbortController().signal)[Symbol.asyncIterator]()
  expect((await stream.next()).value).toMatchObject({ type: 'snapshot', header: { id: chatId } })
  await stream.return?.()
  expect(identity.restore).toHaveBeenCalledOnce()
})

it('restores before resuming a cold root and rejects a conflicting creation preset first', async () => {
  const { controller, headers, owners, identity, factory, presets } = await fixture()
  headers.set(chatId, { ...Session.create(chatId).header, agentPreset: 'main' })
  await expect(controller.create({ ...address, agentId: 'other' })).rejects.toMatchObject({ code: 'session/conflict' })
  expect(owners.size).toBe(0)
  expect(identity.restore).not.toHaveBeenCalled()
  await controller.prompt({ ...address, requestId: 'r', content: [] })
  expect(identity.restore.mock.invocationCallOrder[0]).toBeLessThan(factory.resume.mock.invocationCallOrder[0] ?? Infinity)
  expect(identity.authorizeSession.mock.invocationCallOrder[0]).toBeLessThan(presets.mount.mock.invocationCallOrder[0] ?? Infinity)
})

it('creates and reopens the signed browser chat while rejecting expiry and cached owner conflicts', async () => {
  const { controller, owners, identity } = await fixture()
  const browser = { kind: 'application' as const, chatId, owner, expiresAt: Date.now() + 60_000 }
  const request = { ...address, browser, agentId: 'main' }
  await expect(controller.create(request)).resolves.toEqual({ chatId, agentId: 'main' })
  await expect(controller.create(request)).resolves.toEqual({ chatId, agentId: 'main' })
  await expect(controller.authorizeBrowser(request, { ...browser, expiresAt: 0 })).rejects.toMatchObject({ code: 'CHAT_FORBIDDEN' })
  owners.set(chatId, { ...owner, userId: UserId('foreign') })
  await expect(controller.authorizeBrowser(request, browser)).rejects.toMatchObject({ code: 'CHAT_FORBIDDEN' })
  expect(identity.restore).not.toHaveBeenCalled()
})

it('rejects a different allowed browser preset before restoring a cold root', async () => {
  const { controller, headers, owners, identity } = await fixture(['main', 'plain'])
  headers.set(chatId, { ...Session.create(chatId).header, agentPreset: 'main' })
  const browser = { kind: 'application' as const, chatId, owner, expiresAt: Date.now() + 60_000 }
  await expect(controller.create({ ...address, browser, agentId: 'plain' })).rejects.toMatchObject({ code: 'session/conflict' })
  expect(owners.size).toBe(0)
  expect(identity.restore).not.toHaveBeenCalled()
})
