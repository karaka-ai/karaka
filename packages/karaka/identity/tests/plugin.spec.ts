import { expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { apply, inject, UserId } from '../src/index.ts'
import { fixture, owner } from './helpers.ts'

it('mounts without storage, configuration, or a persistence scan and clears ownership on disposal', async () => {
  const { ctx, persistence } = await fixture(false)
  expect(inject).toEqual(['sessions', 'sessionPersistence'])
  const first = await ctx.plugin({ inject, apply })
  const identity = first.ctx.karakaIdentity
  await identity.reserve(SessionId('chat'), owner)
  expect(persistence.list).not.toHaveBeenCalled()
  await first.dispose()
  await expect(identity.reserve(SessionId('closed'), owner)).rejects.toThrow('authority is closed')
  const next = await ctx.plugin({ inject, apply })
  await expect(next.ctx.karakaIdentity.reserve(SessionId('chat'), { ...owner, userId: UserId('different') })).resolves.toBe('create')
  await next.dispose()
})
