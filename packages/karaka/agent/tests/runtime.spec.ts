import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import { runtime } from '../src/index.ts'
import * as AgentInvariant from '../src/invariant.ts'

describe('Karaka Agent runtime', () => {
  it('publishes the package runtime marker', () => {
    expect(runtime).toBe('karaka-agent')
  })

  it('registers the bundle invariant companion', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    const fiber = await ctx.plugin(AgentInvariant)

    expect(() => {
      ctx.invariants.register('@karaka-ai/agent', () => {})
    }).toThrow(/already registered/u)
    await fiber.dispose()
    await ctx.fiber.dispose()
  })
})
