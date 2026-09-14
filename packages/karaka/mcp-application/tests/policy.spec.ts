/** Agent scopes isolate application policy, inherited restrictions and catalog contributions. */
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createScope } from '@deepseek-ai/dsh-scope'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { applicationToolNames, policyAllows, registerCatalog, registerPolicy, watchPolicy } from '../src/policy.ts'

function policyRoot() {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  return ctx
}

/** The policy store uses Agent object identity only; no Agent methods are invoked. */
function agentScope(ctx: Context, parent?: Agent) {
  const agent = {} as Agent
  const scope = createScope(ctx, agent, parent === undefined ? undefined : { parent })
  onTestFinished(async () => { await scope.dispose() })
  return { agent, ctx: scope.ctx }
}

describe('application tool policy', () => {
  it('requires explicit permission and isolates sibling scopes and roots', () => {
    const root = policyRoot()
    const first = agentScope(root)
    const sibling = agentScope(root)
    const otherRoot = agentScope(policyRoot())
    expect(policyAllows(first.agent, 'mcp__app__read')).toBe(false)
    first.ctx.effect(() => registerPolicy(first.ctx, { allow: ['mcp__app__read'] }))
    expect(policyAllows(first.agent, 'mcp__app__read')).toBe(true)
    expect(policyAllows(first.agent, 'mcp__app__write')).toBe(false)
    expect(policyAllows(sibling.agent, 'mcp__app__read')).toBe(false)
    expect(policyAllows(otherRoot.agent, 'mcp__app__read')).toBe(false)
  })

  it('intersects inherited allow lists and lets ancestor deny override descendants', () => {
    const root = policyRoot()
    const parent = agentScope(root)
    const child = agentScope(root, parent.agent)
    parent.ctx.effect(() => registerPolicy(parent.ctx, { allow: ['read', 'write'], deny: ['write'] }))
    child.ctx.effect(() => registerPolicy(child.ctx, { allow: ['read', 'write', 'admin'] }))
    expect(policyAllows(child.agent, 'read')).toBe(true)
    expect(policyAllows(child.agent, 'write')).toBe(false)
    expect(policyAllows(child.agent, 'admin')).toBe(false)
  })

  it('does not treat deny-only policy as an allow and preserves omitted child allows', () => {
    const root = policyRoot()
    const parent = agentScope(root)
    const child = agentScope(root, parent.agent)
    child.ctx.effect(() => registerPolicy(child.ctx, { deny: ['write'] }))
    expect(policyAllows(child.agent, 'read')).toBe(false)
    parent.ctx.effect(() => registerPolicy(parent.ctx, { allow: ['read', 'write'] }))
    expect(policyAllows(child.agent, 'read')).toBe(true)
    expect(policyAllows(child.agent, 'write')).toBe(false)
  })

  it('removes policy on plugin disposal and stops disposed observers', async () => {
    const root = policyRoot()
    const scoped = agentScope(root)
    const changed = vi.fn()
    const otherRootChanged = vi.fn()
    root.effect(() => watchPolicy(root, changed))
    const foreign = policyRoot()
    foreign.effect(() => watchPolicy(foreign, otherRootChanged))
    const plugin = scoped.ctx.plugin((ctx) => {
      ctx.effect(() => registerPolicy(ctx, { allow: ['read'] }))
    })
    await plugin
    expect(policyAllows(scoped.agent, 'read')).toBe(true)
    expect(changed).toHaveBeenCalledTimes(1)
    await plugin.dispose()
    expect(policyAllows(scoped.agent, 'read')).toBe(false)
    expect(changed).toHaveBeenCalledTimes(2)
    expect(otherRootChanged).not.toHaveBeenCalled()
    const transient = vi.fn()
    const stop = watchPolicy(root, transient)
    stop()
    scoped.ctx.effect(() => registerPolicy(scoped.ctx, { allow: ['read'] }))
    expect(transient).not.toHaveBeenCalled()
  })

  it('rejects an unscoped policy and rolls back admission when an observer rejects it', () => {
    const root = policyRoot()
    expect(() => registerPolicy(root, { allow: ['read'] })).toThrow('inside an Agent preset')
    const scoped = agentScope(root)
    root.effect(() => watchPolicy(root, () => { throw new Error('registration conflict') }))
    expect(() => registerPolicy(scoped.ctx, { allow: ['read'] })).toThrow('registration conflict')
    expect(policyAllows(scoped.agent, 'read')).toBe(false)
  })
})

describe('application tool catalogs', () => {
  it('reference-counts duplicate contributions and isolates roots and returned sets', () => {
    const root = policyRoot()
    const other = policyRoot()
    const first = registerCatalog(root, 'read')
    const second = registerCatalog(root, 'read')
    other.effect(() => registerCatalog(other, 'write'))
    const detached = applicationToolNames(root)
    expect(detached).toEqual(new Set(['read']))
    expect(applicationToolNames(other)).toEqual(new Set(['write']))
    first()
    expect(applicationToolNames(root)).toEqual(new Set(['read']))
    second()
    expect(applicationToolNames(root)).toEqual(new Set())
    expect(detached).toEqual(new Set(['read']))
  })
})
