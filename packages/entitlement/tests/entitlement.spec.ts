import Entitlement, { EntitlementError } from '@karaka/entitlement'
import EntitlementMemory from '@karaka/entitlement/entitlement-memory'
import { Context } from '@karaka/cordis'
import { describe, expect, it } from 'vitest'

describe('Entitlement', () => {
  it('tracks exact overall spend and rejects an exhausted account', async () => {
    const ctx = new Context()

    try {
      await ctx.plugin(Entitlement)
      await ctx.plugin(EntitlementMemory, {
        accounts: { developer: '1000' },
      })

      await expect(ctx.entitlement.assertAvailable('developer', 'USD_MICRO')).resolves.toEqual({
        account: 'developer',
        unit: 'USD_MICRO',
        limit: 1000n,
        spent: 0n,
      })
      await expect(ctx.entitlement.recordSpend('developer', {
        unit: 'USD_MICRO',
        amount: 1000n,
      })).resolves.toMatchObject({ spent: 1000n })
      await expect(ctx.entitlement.assertAvailable('developer', 'USD_MICRO')).rejects.toEqual(
        expect.objectContaining<Partial<EntitlementError>>({ code: 'EXHAUSTED' }),
      )
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('makes the service unavailable when its provider plugin unloads', async () => {
    const ctx = new Context()

    try {
      await ctx.plugin(Entitlement)
      const provider = ctx.plugin(EntitlementMemory, { accounts: { temporary: '1' } })
      await provider
      await provider.dispose()

      await expect(ctx.entitlement.status('temporary')).rejects.toMatchObject({ code: 'UNAVAILABLE' })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('lets the provider resolve account IDs as runtime data', async () => {
    const ctx = new Context()

    try {
      await ctx.plugin(Entitlement)
      await ctx.plugin({
        name: 'dynamic-entitlement',
        inject: ['entitlement'],
        apply(pluginContext) {
          pluginContext.entitlement.register({
            name: 'dynamic',
            async status(account) {
              return { account, unit: 'CREDIT', limit: 10n, spent: 0n }
            },
            async recordSpend(account, spend) {
              return { account, unit: spend.unit, limit: 10n, spent: spend.amount }
            },
          })
        },
      })

      await expect(ctx.entitlement.status('created-after-plugin-load')).resolves.toMatchObject({
        account: 'created-after-plugin-load',
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('keeps unit validation at the entitlement seam', async () => {
    const ctx = new Context()

    try {
      await ctx.plugin(Entitlement)
      await ctx.plugin(EntitlementMemory, { accounts: { developer: '10' } })

      await expect(ctx.entitlement.recordSpend('developer', { unit: 'CREDIT', amount: 1n }))
        .rejects.toMatchObject({ code: 'UNIT_MISMATCH' })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it.each([
    ['wrong-unit result', { account: 'developer', unit: 'OTHER', limit: 100n, spent: 15n }],
    ['stale total', { account: 'developer', unit: 'CREDIT', limit: 100n, spent: 10n }],
  ])('rejects a provider charge with a %s', async (_case, recorded) => {
    const ctx = new Context()

    try {
      await ctx.plugin(Entitlement)
      await ctx.plugin({
        name: 'invalid-entitlement',
        inject: ['entitlement'],
        apply(pluginContext) {
          pluginContext.entitlement.register({
            name: 'invalid',
            async status(account) {
              return { account, unit: 'CREDIT', limit: 100n, spent: 10n }
            },
            async recordSpend() {
              return recorded
            },
          })
        },
      })

      await expect(ctx.entitlement.recordSpend('developer', { unit: 'CREDIT', amount: 5n }))
        .rejects.toMatchObject({ code: 'INVALID_PROVIDER_RESPONSE' })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
