import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Loader } from '@deepseek-ai/cordis-plugin-loader'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import { runtime } from '../src/index.ts'
import * as AgentInvariant from '../src/invariant.ts'
import { bundledPlugins, installBundledPlugins } from '../src/plugins.ts'

describe('Karaka Agent runtime', () => {
  it('publishes one immutable built-in registry into the Loader', () => {
    const builtins: Record<string, unknown> = {}

    installBundledPlugins({ builtins } as unknown as Loader)

    expect(runtime).toBe('karaka-agent')
    expect(Object.isFrozen(bundledPlugins)).toBe(true)
    expect(Object.keys(builtins)).toEqual(Object.keys(bundledPlugins))
    expect(builtins['@karaka-ai/agent/agent-loop']).toBe(bundledPlugins['@karaka-ai/agent/agent-loop'])
    expect(Object.keys(builtins).every(name => name.startsWith('@karaka-ai/agent/'))).toBe(true)
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
