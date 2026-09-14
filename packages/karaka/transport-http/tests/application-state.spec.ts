/** Durable receipt and model-selection reconstruction through the real Session projection registry. */
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import SessionStore, { Session, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { describe, expect, it, onTestFinished } from 'vitest'
import { applicationState, installApplicationProjection } from '../src/application-state.ts'

async function fixture() {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  installApplicationProjection(ctx)
  return { ctx, session: ctx.sessions.create(SessionId('application-state')) }
}

function message(id?: string) {
  return createUserMessage({
    content: [{ type: 'text', text: 'prompt' }],
    source: id === undefined ? { kind: 'user' } : { kind: 'user', rpcId: id as SessionRequestId },
  })
}

describe('application Session state', () => {
  it('records inbox IDs before model consumption and keeps each durable receipt once', async () => {
    const { ctx, session } = await fixture()
    session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [message('first'), message('first')] })
    expect(applicationState(ctx, session).requestIds).toEqual(['first'])
    session.append('user/message', message('first'), { surfaceOp: 'append' })
    session.append('user/message', message('second'), { surfaceOp: 'append' })
    session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [], removedCount: 2, outcome: 'canceled' })
    expect(applicationState(ctx, session).requestIds).toEqual(['first', 'second'])
  })

  it('retains the same state for unrelated events and messages without application IDs', async () => {
    const { ctx, session } = await fixture()
    const initial = applicationState(ctx, session)
    session.append('turn/start', { turn: 1 })
    session.append('user/message', message(), { surfaceOp: 'append' })
    expect(applicationState(ctx, session)).toBe(initial)
  })

  it('restores receipts and pending selection from a detached durable Session', async () => {
    const { ctx, session } = await fixture()
    session.append('user/message', message('persisted'), { surfaceOp: 'append' })
    session.append('model/selection', { provider: 'provider', model: 'selected' })
    const restored = Session.create(session.id, session.snapshotEvents(), session.header)
    expect(applicationState(ctx, restored)).toEqual({
      requestIds: ['persisted'], lastUsed: null, pending: { provider: 'provider', model: 'selected' },
    })
  })

  it.each([undefined, ReasoningEffortId('high')])('consumes a matching selection with effort %s', async (reasoningEffort) => {
    const { ctx, session } = await fixture()
    const selected = { provider: 'provider', model: 'selected', ...(reasoningEffort === undefined ? {} : { reasoningEffort }) }
    session.append('model/selection', selected)
    session.append('request/header', { header: { config: selected }, reason: 'initial' })
    expect(applicationState(ctx, session)).toEqual({ requestIds: [], pending: null, lastUsed: selected })
  })

  it.each([
    { provider: 'other', model: 'selected', reasoningEffort: ReasoningEffortId('high') },
    { provider: 'provider', model: 'other', reasoningEffort: ReasoningEffortId('high') },
    { provider: 'provider', model: 'selected', reasoningEffort: ReasoningEffortId('low') },
  ])('keeps pending selection when the request uses another route or effort: %j', async (used) => {
    const { ctx, session } = await fixture()
    const selected = { provider: 'provider', model: 'selected', reasoningEffort: ReasoningEffortId('high') }
    session.append('model/selection', selected)
    session.append('request/header', { header: { config: used }, reason: 'initial' })
    expect(applicationState(ctx, session)).toEqual({ requestIds: [], pending: selected, lastUsed: used })
  })

  it('keeps adapter-default effort out of the restored last-used selection', async () => {
    const { ctx, session } = await fixture()
    session.append('request/header', {
      header: { config: { provider: 'provider', model: 'model', reasoningEffort: ReasoningEffortId('high') }, adapterDefaults: { reasoningEffort: true } },
      reason: 'initial',
    })
    expect(applicationState(ctx, session).lastUsed).toEqual({ provider: 'provider', model: 'model' })
  })

  it.each([undefined, ReasoningEffortId('high')])('restores validated projection checkpoints with effort %s', async (reasoningEffort) => {
    const { ctx, session } = await fixture()
    const selected = { provider: 'provider', model: 'selected', ...(reasoningEffort === undefined ? {} : { reasoningEffort }) }
    session.append('model/selection', selected)
    const checkpoint = ctx.sessionProjections.checkpoint(session)
    const restored = ctx.sessionProjections.restore(
      checkpoint, session.snapshotEvents(), SessionLogOffset(0), session.header, SessionLogOffset(0),
    )
    expect(restored.checkpoint.karakaApplication?.val).toEqual(applicationState(ctx, session))
  })

  it('rejects an absent projection instead of silently resetting admission state', async () => {
    const ctx = new Context()
    onTestFinished(async () => { await ctx.fiber.dispose() })
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    expect(() => applicationState(ctx, Session.create(SessionId('missing-projection')))).toThrow('not registered')
  })
})
