import { Context } from '@deepseek-ai/cordis'
import { ApplicationId } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import BearerServerAuth from '@karaka/server-auth'

function credentials(values: Map<string, string>) {
  return {
    resolve: (ref: string) => Promise.resolve(values.has(ref)
      ? { value: values.get(ref) as string, source: 'test' }
      : undefined),
  }
}

describe('BearerServerAuth', () => {
  it('uses separate per-operation credentials in both directions', async () => {
    const ctx = new Context()
    const values = new Map([
      ['CHAT_TOKEN', 'chat-secret'],
      ['TOOL_TOKEN', 'tool-secret'],
    ])
    ctx.provide('credentials', credentials(values) as never)
    await ctx.plugin(BearerServerAuth, {
      applications: [{ id: 'billing', chatCredential: 'CHAT_TOKEN', toolCredential: 'TOOL_TOKEN' }],
    })

    await expect(ctx.serverAuth.authenticate('Bearer chat-secret'))
      .resolves.toEqual({ applicationId: 'billing' })
    await expect(ctx.serverAuth.authenticate('Bearer tool-secret')).resolves.toBeUndefined()
    await expect(ctx.serverAuth.authorizeTools(ApplicationId('billing'))).resolves.toBe('Bearer tool-secret')

    values.set('TOOL_TOKEN', 'rotated')
    await expect(ctx.serverAuth.authorizeTools(ApplicationId('billing'))).resolves.toBe('Bearer rotated')
    await ctx.fiber.dispose()
  })

  it('rejects duplicate application ids and missing outbound credentials', async () => {
    const ctx = new Context()
    ctx.provide('credentials', credentials(new Map([['CHAT_TOKEN', 'chat-secret']])) as never)
    await expect(ctx.plugin(BearerServerAuth, {
      applications: [
        { id: 'billing', chatCredential: 'CHAT_TOKEN', toolCredential: 'TOOL_TOKEN' },
        { id: 'billing', chatCredential: 'CHAT_TOKEN', toolCredential: 'TOOL_TOKEN' },
      ],
    })).rejects.toThrow(/duplicate application id/)

    await ctx.plugin(BearerServerAuth, {
      applications: [{ id: 'billing', chatCredential: 'CHAT_TOKEN', toolCredential: 'TOOL_TOKEN' }],
    })
    await expect(ctx.serverAuth.authorizeTools(ApplicationId('billing'))).rejects.toThrow(/not configured/)
    await ctx.fiber.dispose()
  })

  it('fails closed when one bearer value matches multiple applications', async () => {
    const ctx = new Context()
    const values = new Map([
      ['CHAT_A', 'shared-secret'],
      ['CHAT_B', 'shared-secret'],
      ['TOOL_A', 'tool-a'],
      ['TOOL_B', 'tool-b'],
    ])
    ctx.provide('credentials', credentials(values) as never)
    await ctx.plugin(BearerServerAuth, {
      applications: [
        { id: 'billing', chatCredential: 'CHAT_A', toolCredential: 'TOOL_A' },
        { id: 'support', chatCredential: 'CHAT_B', toolCredential: 'TOOL_B' },
      ],
    })

    await expect(ctx.serverAuth.authenticate('Bearer shared-secret')).resolves.toBeUndefined()
    values.set('CHAT_B', 'support-secret')
    await expect(ctx.serverAuth.authenticate('Bearer shared-secret'))
      .resolves.toEqual({ applicationId: 'billing' })
    await ctx.fiber.dispose()
  })

  it('stops waiting for credential resolution when the caller is cancelled', async () => {
    const ctx = new Context()
    ctx.provide('credentials', { resolve: () => new Promise(() => undefined) } as never)
    await ctx.plugin(BearerServerAuth, {
      applications: [{ id: 'billing', chatCredential: 'CHAT_TOKEN', toolCredential: 'TOOL_TOKEN' }],
    })
    const abort = new AbortController()
    const authentication = ctx.serverAuth.authenticate('Bearer chat-secret', abort.signal)
    abort.abort(new Error('cancelled'))

    await expect(authentication).rejects.toThrow('cancelled')
    await ctx.fiber.dispose()
  })
})
