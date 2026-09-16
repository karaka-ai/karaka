/** Preset policy preserves DSH global tools and scoped application authorization together. */
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createScope } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { describe, expect, it, onTestFinished } from 'vitest'
import * as ToolPolicy from '../src/tool-policy.ts'
import { policyAllows, registerCatalog, registerPolicy } from '../src/policy.ts'

async function fixture() {
  const root = new Context()
  onTestFinished(async () => { await root.fiber.dispose() })
  await root.plugin(SystemPrompt)
  await root.plugin(ToolRuntime)
  for (const name of ['read', 'write']) root.tools.register({
    name, description: name, parameters: { type: 'object' },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value as string }] },
    execute: async () => name,
  })
  root.effect(() => registerCatalog(root, 'mcp__app__read'))
  const driver = root.plugin(Object.assign(() => {}, { inject: ['tools'] }))
  await driver
  // Policy lookup uses only the Agent's registered scope identity.
  const agent = {} as Agent
  const scope = createScope(driver.ctx, agent)
  const visible = () => root.tools.schemas(agent).map(tool => tool.name).sort()
  return { root, agent, scope, visible }
}

describe('preset tool policy', () => {
  it('leaves omitted restrictions absent and preserves native global tools', async () => {
    const f = await fixture()
    // Raw configuration omits fields that the schema supplies before plugin activation.
    const config = ToolPolicy.Config({} as never)
    expect(config).toEqual({ mode: 'native', allow: undefined, deny: undefined })
    await f.scope.ctx.plugin(ToolPolicy, config)
    expect(f.visible()).toEqual(['read', 'write'])
    expect(policyAllows(f.agent, 'mcp__app__read')).toBe(false)
  })

  it('restricts global names independently and releases scoped application grants on disposal', async () => {
    const f = await fixture()
    const fiber = f.scope.ctx.plugin(ToolPolicy, { mode: 'native', allow: ['read', 'mcp__app__read'] })
    await fiber
    expect(f.visible()).toEqual(['read'])
    expect(policyAllows(f.agent, 'mcp__app__read')).toBe(true)
    await fiber.dispose()
    expect(f.visible()).toEqual(['read', 'write'])
    expect(policyAllows(f.agent, 'mcp__app__read')).toBe(false)
  })

  it('supports deny-only lists and lets inherited denial override an application grant', async () => {
    const f = await fixture()
    f.scope.ctx.effect(() => registerPolicy(f.scope.ctx, { allow: ['mcp__app__read'] }))
    const fiber = f.scope.ctx.plugin(ToolPolicy, { mode: 'native', deny: ['write', 'mcp__app__read'] })
    await fiber
    expect(f.visible()).toEqual(['read'])
    expect(policyAllows(f.agent, 'mcp__app__read')).toBe(false)
    await fiber.dispose()
    expect(f.visible()).toEqual(['read', 'write'])
    expect(policyAllows(f.agent, 'mcp__app__read')).toBe(true)
  })
})
