import { Context } from '@deepseek-ai/cordis'
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { describe, expect, it, vi } from 'vitest'
import { apply } from '../src/client/index.ts'

// Generated contributions are build artifacts; selection tests supply source-local descriptors.
const remote = vi.hoisted(() => (name: string, methods: string[] = []) => ({
  default: {
    package: name,
    descriptors: methods.map(method => ({
      id: `${name}#session/${method}`, service: 'sessionController', namespace: 'session', method,
      invocation: { kind: 'direct' as const }, parameters: [], result: { mode: 'src-json' as const },
    })),
  } satisfies TypertRemoteContribution,
}))
vi.mock('@deepseek-ai/dsh-agent-presets/remote', () => remote('presets'))
vi.mock('@deepseek-ai/dsh-commands/remote', () => remote('commands'))
vi.mock('@deepseek-ai/dsh-api-settings-controller/remote', () => remote('settings'))
vi.mock('@deepseek-ai/dsh-goal/remote', () => remote('goals'))
vi.mock('@deepseek-ai/dsh-llm/remote', () => remote('llm'))
vi.mock('@deepseek-ai/dsh-cordis-host-runner/remote', () => remote('dynamic'))
vi.mock('@deepseek-ai/dsh-host-plugin-inventory/remote', () => remote('plugins'))
vi.mock('@deepseek-ai/dsh-message-feedback/remote', () => remote('feedback'))
vi.mock('@deepseek-ai/dsh-session-reference/remote', () => remote('references'))
vi.mock('@deepseek-ai/dsh-subagent/remote', () => remote('subagents'))
vi.mock('@deepseek-ai/dsh-api-session-controller/remote', () => remote('session', ['applicationHistory', 'applicationCancel', 'list']))
vi.mock('@deepseek-ai/dsh-api-workspace-controller/remote', () => remote('workspace'))

describe('application Client method selection', () => {
  it.each([
    { applicationMethods: ['applicationHistory'] as const },
    { applicationMethods: [] as const },
  ])('mounts exactly the selected application methods: $applicationMethods', async ({ applicationMethods }) => {
    const ctx = new Context()
    const dispose = vi.fn(async () => {})
    const mount = vi.fn(async (_contribution: TypertRemoteContribution) => dispose)
    ctx.provide('remote', { $mount: mount } as never)
    try {
      const unmount = await apply(ctx, { applicationMethods })
      expect(mount).toHaveBeenCalledOnce()
      const contribution = mount.mock.calls[0]![0]
      expect(contribution.package).toBe('session')
      expect(contribution.descriptors.map(method => method.method)).toEqual(applicationMethods)
      await unmount()
      expect(dispose).toHaveBeenCalledOnce()
    } finally { await ctx.fiber.dispose() }
  })

  it('preserves the Host capability assembly when application selection is omitted', async () => {
    const ctx = new Context()
    const mounted: string[] = []
    const removed: string[] = []
    ctx.provide('remote', {
      $mount: async (contribution: TypertRemoteContribution) => {
        mounted.push(contribution.package)
        return async () => { removed.push(contribution.package) }
      },
    } as never)
    try {
      const unmount = await apply(ctx)
      expect(mounted).toContain('settings')
      expect(mounted).toContain('dynamic')
      expect(mounted).toContain('session')
      await unmount()
      expect(removed).toEqual([...mounted].reverse())
    } finally { await ctx.fiber.dispose() }
  })
})
