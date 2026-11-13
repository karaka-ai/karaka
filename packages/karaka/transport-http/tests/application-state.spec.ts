/** Durable receipt reconstruction through the real Session projection registry. */
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
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
  const projection = await installApplicationProjection(ctx)
  return { ctx, projection, session: ctx.sessions.create(SessionId('application-state')) }
}

function message(id?: string) {
  return createUserMessage({
    content: [{ type: 'text', text: 'prompt' }],
    source: id === undefined ? { kind: 'user' } : { kind: 'user', rpcId: id as SessionRequestId },
  })
}

describe('application Session state', () => {
  it('records inbox IDs before model consumption and keeps each durable receipt once', async () => {
    const { projection, session } = await fixture()
    session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [message('first'), message('first')] })
    expect(applicationState(projection, session).requestIds).toEqual(['first'])
    session.append('user/message', message('first'), { surfaceOp: 'append' })
    session.append('user/message', message('second'), { surfaceOp: 'append' })
    session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [], removedCount: 2, outcome: 'canceled' })
    expect(applicationState(projection, session).requestIds).toEqual(['first', 'second'])
  })

  it('retains the same state for unrelated events and messages without application IDs', async () => {
    const { projection, session } = await fixture()
    const initial = applicationState(projection, session)
    session.append('turn/start', { turn: 1 })
    session.append('user/message', message(), { surfaceOp: 'append' })
    expect(applicationState(projection, session)).toBe(initial)
  })

  it('restores receipts from a detached durable Session', async () => {
    const { projection, session } = await fixture()
    session.append('user/message', message('persisted'), { surfaceOp: 'append' })
    const restored = Session.create(session.id, session.snapshotEvents(), session.header)
    expect(applicationState(projection, restored)).toEqual({
      requestIds: ['persisted'],
    })
  })

  it('restores validated receipt checkpoints', async () => {
    const { ctx, projection, session } = await fixture()
    session.append('user/message', message('persisted'), { surfaceOp: 'append' })
    const checkpoint = ctx.sessionProjections.checkpoint(session)
    const restored = ctx.sessionProjections.restore(
      checkpoint, session.snapshotEvents(), SessionLogOffset(0), session.header, SessionLogOffset(0),
    )
    expect(restored.checkpoint.karakaApplication?.val).toEqual(applicationState(projection, session))
  })

  it('retains the application reader after unregistering its global projection', async () => {
    const { projection, session } = await fixture()
    await projection.dispose()
    session.append('user/message', message('after-disposal'), { surfaceOp: 'append' })
    expect(applicationState(projection, session).requestIds).toEqual(['after-disposal'])
  })
})
