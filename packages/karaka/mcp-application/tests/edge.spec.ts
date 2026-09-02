import { describe, expect, it, vi } from 'vitest'
import { ApplicationId, SessionId, TenantId, UserId } from '@deepseek-ai/dsh-session'

const mocks = vi.hoisted(() => ({ apply: vi.fn() }))

vi.mock('@deepseek-ai/dsh-mcp-client', () => ({ apply: mocks.apply }))

import { apply } from '../src/index.ts'

const config = {
  applicationId: 'billing',
  serverName: 'billing',
  url: 'https://application.example/mcp',
  headers: {},
  toolCallTimeoutMs: 5_000,
  failOnStartupError: true,
}

describe('application MCP identity edges', () => {
  it('rejects an empty application identity before connecting', async () => {
    await expect(apply({} as never, { ...config, applicationId: '' })).rejects.toThrow(/must not be empty/u)
    expect(mocks.apply).not.toHaveBeenCalled()
  })

  it('authorizes discovery and rejects unowned or cross-application invocations', async () => {
    let hooks!: {
      requestHeaders(signal: AbortSignal): Promise<Record<string, string>>
      invocationMeta(execution: unknown): unknown
      isToolVisible(name: string, visibility: unknown): boolean
    }
    mocks.apply.mockImplementation(async (_ctx: unknown, _config: unknown, value: typeof hooks) => { hooks = value })
    const authorizeTools = vi.fn().mockResolvedValue('Bearer tool-secret')
    await apply({ serverAuth: { authorizeTools } } as never, config)

    const signal = AbortSignal.timeout(5_000)
    await expect(hooks.requestHeaders(signal)).resolves.toEqual({ authorization: 'Bearer tool-secret' })
    expect(authorizeTools).toHaveBeenCalledWith(ApplicationId('billing'), signal)
    expect(() => hooks.invocationMeta({})).toThrow(/application-owned Agent session/u)
    expect(() => hooks.invocationMeta({ agent: { session: { header: {} } } }))
      .toThrow(/application-owned Agent session/u)
    expect(() => hooks.invocationMeta({
      agent: {
        session: {
          id: SessionId('chat-1'),
          header: {
            applicationOwner: {
              applicationId: ApplicationId('support'),
              tenantId: TenantId('tenant-1'),
              userId: UserId('user-1'),
            },
          },
        },
      },
    })).toThrow(/does not match endpoint application/u)
  })

  it('shows tools only to explicitly allowed sessions owned by the endpoint application', async () => {
    let visible!: (name: string, value: unknown) => boolean
    mocks.apply.mockImplementation(async (_ctx: unknown, _config: unknown, hooks: {
      isToolVisible(name: string, value: unknown): boolean
    }) => { visible = (name, value) => hooks.isToolVisible(name, value) })
    await apply({ serverAuth: { authorizeTools: vi.fn() } } as never, config)
    const base = { inherited: true, explicitlyAllowed: true }

    expect(visible('tool', { ...base, inherited: false })).toBe(false)
    expect(visible('tool', { ...base, explicitlyAllowed: false })).toBe(false)
    expect(visible('tool', base)).toBe(false)
    expect(visible('tool', { ...base, scope: {} })).toBe(false)
    expect(visible('tool', { ...base, scope: { session: null } })).toBe(false)
    expect(visible('tool', { ...base, scope: { session: {} } })).toBe(false)
    expect(visible('tool', { ...base, scope: { session: { header: null } } })).toBe(false)
    expect(visible('tool', { ...base, scope: { session: { header: {} } } })).toBe(false)
    expect(visible('tool', { ...base, scope: { session: { header: { applicationOwner: null } } } })).toBe(false)
    expect(visible('tool', {
      ...base,
      scope: { session: { header: { applicationOwner: { applicationId: ApplicationId('support') } } } },
    })).toBe(false)
    expect(visible('tool', {
      ...base,
      scope: { session: { header: { applicationOwner: { applicationId: ApplicationId('billing') } } } },
    })).toBe(true)
  })
})
