import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId, SessionLogOffset, type Session } from '@deepseek-ai/dsh-session'
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import { expect, it, vi } from 'vitest'
import { UserId } from '../src/index.ts'
import KarakaSessionReferenceResolver from '../src/session-reference.ts'
import { fixture, owner } from './helpers.ts'

function agent(session: Session): Agent {
  // Reference preparation consumes only the Agent's id, Session, and selected model options.
  return { id: session.id, session, options: {} } as Agent
}

async function references(candidateLimit?: number) {
  const state = await fixture()
  const { ctx, stored } = state
  const readSurface = vi.fn(async (id: SessionId) => {
    const header = stored.get(id)
    if (header === undefined) throw new Error('missing source')
    return { session: header, inheritedEventCount: SessionLogOffset(0), capturedThroughSeq: null, events: [] }
  })
  // The inherited resolver uses metadata listing and exact surface reads, not search indexing.
  const sessionQuery = {
    listSessions: async () => [...stored.values()].map(header => ({ header, live: true, persisted: true })),
    readSurface,
  } satisfies Pick<typeof ctx.sessionQuery, 'listSessions' | 'readSurface'>
  ctx.provide('sessionQuery', Object.setPrototypeOf(sessionQuery, SessionQueryEngine.prototype) as SessionQueryEngine)
  const resolver = candidateLimit === undefined
    ? new KarakaSessionReferenceResolver(ctx)
    : new KarakaSessionReferenceResolver(ctx, { candidateLimit })
  return { ...state, resolver, readSurface }
}

it('filters foreign references before applying the configured candidate cap', async () => {
  const { create, resolver } = await references(1)
  const target = await create(SessionId('target'))
  await create(SessionId('foreign'), { ...owner, userId: UserId('foreign') })
  const allowed = await create(SessionId('allowed'))
  await create(SessionId('another'))
  expect((await resolver.listCandidates(agent(target))).map(row => row.sessionId)).toEqual([allowed.id])
  expect((await resolver.listCandidates(agent(target), 'another', 5)).map(row => row.sessionId)).toEqual([SessionId('another')])
})

it('keeps ordinary DSH references separate from application chats', async () => {
  const { ctx, stored, create, resolver, readSurface } = await references()
  const application = await create()
  const ordinary = ctx.sessions.create(SessionId('ordinary'))
  const other = ctx.sessions.create(SessionId('other-ordinary'))
  stored.set(ordinary.id, ordinary.header)
  stored.set(other.id, other.header)
  expect((await resolver.listCandidates(agent(ordinary))).map(row => row.sessionId)).toEqual([other.id])
  expect((await resolver.listCandidates(agent(application))).map(row => row.sessionId)).toEqual([])
  await expect(resolver.prepare(agent(ordinary), [], [{ sessionId: application.id }])).rejects.toMatchObject({ code: 'forbidden' })
  expect(readSurface).not.toHaveBeenCalled()
  expect((await resolver.prepare(agent(ordinary), [], [{ sessionId: other.id }])).additionalContext?.source.kind).toBe('session-reference')
})

it('authorizes every target before reading any reference and retains upstream context rendering', async () => {
  const { create, resolver, readSurface } = await references()
  const target = await create(SessionId('target'))
  const allowed = await create(SessionId('allowed'))
  const foreign = await create(SessionId('foreign'), { ...owner, userId: UserId('foreign') })
  await expect(resolver.prepare(agent(target), [], [{ sessionId: allowed.id }, { sessionId: foreign.id }])).rejects.toMatchObject({ code: 'forbidden' })
  expect(readSurface).not.toHaveBeenCalled()
  const result = await resolver.prepare(agent(target), [{ type: 'text', text: 'read this' }], [{ sessionId: allowed.id }])
  expect(result.content).toEqual([{ type: 'text', text: 'read this' }])
  expect(result.additionalContext?.source).toMatchObject({ kind: 'session-reference', references: [{ sessionId: allowed.id }] })
  expect(readSurface).toHaveBeenCalledWith(allowed.id)
})

it.each([0, 1.5])('rejects invalid candidate limit %s', async (limit) => {
  const { create, resolver } = await references()
  await expect(resolver.listCandidates(agent(await create()), '', limit)).rejects.toMatchObject({ code: 'SESSION_REFERENCE_INVALID_REFERENCE' })
})

it('stops reference preparation when cancellation occurs during an ownership lookup', async () => {
  const { create, resolver, authority, readSurface } = await references()
  const target = await create(SessionId('target'))
  const source = await create(SessionId('source'))
  const controller = new AbortController()
  const lookup = vi.spyOn(authority, 'ownerOfId').mockImplementationOnce(async () => {
    controller.abort('left')
    return owner
  })
  try {
    await expect(resolver.prepare(agent(target), [], [{ sessionId: source.id }], controller.signal)).rejects.toMatchObject({ code: 'SESSION_REFERENCE_CANCELLED' })
    expect(readSurface).not.toHaveBeenCalled()
  } finally {
    lookup.mockRestore()
  }
})
