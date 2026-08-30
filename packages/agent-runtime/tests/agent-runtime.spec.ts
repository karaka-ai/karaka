import AgentRuntime, { AgentModelsService, AgentRuntimeError } from '@karaka/agent-runtime'
import EchoModel from '@karaka/agent-runtime/model-echo'
import { Context, type Context as CordisContext } from '@karaka/cordis'
import Entitlement from '@karaka/entitlement'
import EntitlementLocal from '@karaka/entitlement/local'
import Include from '@karaka/cordis-plugin-include'
import Loader from '@karaka/cordis-plugin-loader'
import { describe, expect, it } from 'vitest'

describe('Agent Runtime', () => {
  it('loads an agent plugin from setup YAML and runs one turn', async () => {
    const ctx = new Context()
    ctx.baseUrl = new URL('./fixtures/', import.meta.url).href

    try {
      await ctx.plugin(Loader)
      ctx.loader.builtins.include = Include
      await ctx.loader.create({
        name: 'cordis:include',
        config: { path: new URL('cordis.yml', ctx.baseUrl).href },
      })
      await ctx.loader.await()

      await expect(ctx.agentRuntime.run({
        agentId: 'support',
        message: 'Hello',
      })).resolves.toEqual({
        agentId: 'support',
        model: 'support-model',
        message: { role: 'assistant', content: 'Received: Hello' },
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('removes agent and model contributions with their plugins', async () => {
    const ctx = new Context()

    try {
      await ctx.plugin(Entitlement)
      await ctx.plugin(AgentRuntime)
      const model = ctx.plugin(EchoModel, { id: 'test-model' })
      const agent = ctx.plugin(createAgentPlugin('test-agent', 'test-model'))
      await Promise.all([model, agent])

      expect(ctx.agentRuntime.listAgents()).toEqual([
        { id: 'test-agent', prompt: 'Test prompt', model: 'test-model' },
      ])
      expect(ctx.agentRuntime.listModels()).toEqual(['test-model'])

      await model.dispose()
      await expect(ctx.agentRuntime.run({ agentId: 'test-agent', message: 'Hello' }))
        .rejects.toMatchObject({ code: 'UNKNOWN_MODEL' })

      await agent.dispose()
      expect(ctx.agentRuntime.listAgents()).toEqual([])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('binds globally addressable agents to native Cordis model services', async () => {
    const ctx = new Context()

    try {
      await ctx.plugin(Entitlement)
      await ctx.plugin(AgentRuntime)
      const support = ctx.isolate(AgentModelsService.provide)
      const billing = ctx.isolate(AgentModelsService.provide)
      const supportModels = support.plugin(AgentModelsService)
      await supportModels
      await billing.plugin(AgentModelsService)

      const supportModel = support.plugin(createModelPlugin('shared-model', 'support response'))
      await supportModel
      await support.plugin(createAgentPlugin('support', 'shared-model'))
      await billing.plugin(createModelPlugin('shared-model', 'billing response'))
      await billing.plugin(createAgentPlugin('billing', 'shared-model'))

      expect(ctx.agentRuntime.listModels()).toEqual([])
      expect(support.agentRuntime.listModels()).toEqual(['shared-model'])
      expect(billing.agentRuntime.listModels()).toEqual(['shared-model'])
      await expect(ctx.agentRuntime.run({ agentId: 'support', message: 'Hello' }))
        .resolves.toMatchObject({ message: { content: 'support response' } })
      await expect(ctx.agentRuntime.run({ agentId: 'billing', message: 'Hello' }))
        .resolves.toMatchObject({ message: { content: 'billing response' } })

      await supportModel.dispose()
      await expect(ctx.agentRuntime.run({ agentId: 'support', message: 'Again' }))
        .rejects.toMatchObject({ code: 'UNKNOWN_MODEL' })
      await expect(ctx.agentRuntime.run({ agentId: 'billing', message: 'Again' }))
        .resolves.toMatchObject({ message: { content: 'billing response' } })

      await supportModels.dispose()
      await expect(ctx.agentRuntime.run({ agentId: 'support', message: 'After disposal' }))
        .rejects.toMatchObject({ code: 'UNKNOWN_AGENT' })
      await expect(ctx.agentRuntime.run({ agentId: 'billing', message: 'After disposal' }))
        .resolves.toMatchObject({ message: { content: 'billing response' } })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('rejects invalid requests and model responses at the seam', async () => {
    const ctx = new Context()

    try {
      await ctx.plugin(Entitlement)
      await ctx.plugin(AgentRuntime)
      await expect(ctx.agentRuntime.run({ agentId: '', message: 'Hello' })).rejects.toEqual(
        expect.objectContaining<Partial<AgentRuntimeError>>({ code: 'INVALID_REQUEST' }),
      )

      await ctx.plugin(createAgentPlugin('broken-agent', 'broken-model'))
      await ctx.plugin({
        name: 'broken-model',
        inject: ['agentModels'],
        apply(pluginContext) {
          pluginContext.agentModels.register({
            id: 'broken-model',
            async generate() {
              return { message: { role: 'user', content: 'not an assistant response' } }
            },
          })
        },
      })

      await expect(ctx.agentRuntime.run({ agentId: 'broken-agent', message: 'Hello' }))
        .rejects.toMatchObject({ code: 'INVALID_MODEL_RESPONSE' })

      await ctx.plugin(createAgentPlugin('hidden-spend-agent', 'hidden-spend-model'))
      await ctx.plugin({
        name: 'hidden-spend-model',
        inject: ['agentModels'],
        apply(pluginContext) {
          pluginContext.agentModels.register({
            id: 'hidden-spend-model',
            async generate() {
              return {
                message: { role: 'assistant', content: 'not really unmetered' },
                spend: { unit: 'USD_MICRO', amount: 1n },
              }
            },
          })
        },
      })

      await expect(ctx.agentRuntime.run({ agentId: 'hidden-spend-agent', message: 'Hello' }))
        .rejects.toMatchObject({ code: 'INVALID_MODEL_RESPONSE' })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('checks overall availability and records actual model spend without a per-call budget', async () => {
    const ctx = new Context()
    let calls = 0

    try {
      await ctx.plugin(Entitlement)
      await ctx.plugin(EntitlementLocal, { defaultLimit: '100' })
      await ctx.plugin(AgentRuntime)
      await ctx.plugin(createAgentPlugin('paid-agent', 'paid-model'))
      await ctx.plugin({
        name: 'paid-model',
        inject: ['agentModels'],
        apply(pluginContext) {
          pluginContext.agentModels.register({
            id: 'paid-model',
            spendUnit: 'USD_MICRO',
            async generate() {
              calls++
              return {
                message: { role: 'assistant', content: 'paid response' },
                spend: { unit: 'USD_MICRO', amount: 60n },
              }
            },
          })
        },
      })

      const request = { agentId: 'paid-agent', message: 'Hello', entitlementAccount: 'paid' }
      await expect(ctx.agentRuntime.run(request)).resolves.toMatchObject({ model: 'paid-model' })
      await expect(ctx.agentRuntime.run(request)).resolves.toMatchObject({ model: 'paid-model' })
      await expect(ctx.entitlement.status('paid')).resolves.toMatchObject({ limit: 100n, spent: 120n })
      await expect(ctx.agentRuntime.run(request)).rejects.toMatchObject({ code: 'EXHAUSTED' })
      expect(calls).toBe(2)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('records valid model spend before rejecting an invalid assistant message', async () => {
    const ctx = new Context()

    try {
      await ctx.plugin(Entitlement)
      await ctx.plugin(EntitlementLocal, { defaultLimit: '100' })
      await ctx.plugin(AgentRuntime)
      await ctx.plugin(createAgentPlugin('invalid-agent', 'invalid-model'))
      await ctx.plugin({
        name: 'invalid-metered-model',
        inject: ['agentModels'],
        apply(pluginContext) {
          pluginContext.agentModels.register({
            id: 'invalid-model',
            spendUnit: 'USD_MICRO',
            async generate() {
              return {
                message: { role: 'user', content: 'not an assistant response' },
                spend: { unit: 'USD_MICRO', amount: 7n },
              }
            },
          })
        },
      })

      await expect(ctx.agentRuntime.run({
        agentId: 'invalid-agent',
        message: 'Hello',
        entitlementAccount: 'paid',
      })).rejects.toMatchObject({ code: 'INVALID_MODEL_RESPONSE' })
      await expect(ctx.entitlement.status('paid')).resolves.toMatchObject({ spent: 7n })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it.each([
    ['provider disposal', false],
    ['provider replacement', true],
  ])('keeps an in-flight run on its checked provider during %s', async (_case, replaceProvider) => {
    const ctx = new Context()
    const generationStarted = deferred<void>()
    const finishGeneration = deferred<void>()
    const accountingStarted = deferred<void>()
    const finishAccounting = deferred<void>()
    const original = {
      spent: 0n,
      async beforeRecord() {
        accountingStarted.resolve()
        await finishAccounting.promise
      },
    }
    const replacement = { spent: 0n }

    try {
      await ctx.plugin(Entitlement)
      const originalPlugin = ctx.plugin(createEntitlementPlugin('original', original))
      await originalPlugin
      await ctx.plugin(AgentRuntime)
      await ctx.plugin(createAgentPlugin('paid-agent', 'paid-model'))
      await ctx.plugin({
        name: 'delayed-paid-model',
        inject: ['agentModels'],
        apply(pluginContext) {
          pluginContext.agentModels.register({
            id: 'paid-model',
            spendUnit: 'USD_MICRO',
            async generate() {
              generationStarted.resolve()
              await finishGeneration.promise
              return {
                message: { role: 'assistant', content: 'paid response' },
                spend: { unit: 'USD_MICRO', amount: 25n },
              }
            },
          })
        },
      })

      const run = ctx.agentRuntime.run({
        agentId: 'paid-agent',
        message: 'Hello',
        entitlementAccount: 'paid',
      })
      await generationStarted.promise

      let disposalFinished = false
      const disposal = originalPlugin.dispose().then(() => {
        disposalFinished = true
      })
      await expect.poll(async () => {
        try {
          await ctx.entitlement.status('paid')
          return 'AVAILABLE'
        } catch (error) {
          return (error as { code?: string }).code
        }
      }).toBe('UNAVAILABLE')
      expect(disposalFinished).toBe(false)

      if (replaceProvider) await ctx.plugin(createEntitlementPlugin('replacement', replacement))
      finishGeneration.resolve()
      await accountingStarted.promise
      expect(disposalFinished).toBe(false)
      expect(replacement.spent).toBe(0n)
      finishAccounting.resolve()

      await expect(run).resolves.toMatchObject({ model: 'paid-model' })
      await disposal
      expect(original.spent).toBe(25n)
      expect(replacement.spent).toBe(0n)
      if (replaceProvider) {
        await expect(ctx.entitlement.status('paid')).resolves.toMatchObject({ spent: 0n })
      } else {
        await expect(ctx.entitlement.status('paid')).rejects.toMatchObject({ code: 'UNAVAILABLE' })
      }
    } finally {
      finishGeneration.resolve()
      finishAccounting.resolve()
      await ctx.fiber.dispose()
    }
  })

  it('requires an overall account for metered models', async () => {
    const ctx = new Context()

    try {
      await ctx.plugin(Entitlement)
      await ctx.plugin(EntitlementLocal, { defaultLimit: '100' })
      await ctx.plugin(AgentRuntime)
      await ctx.plugin(createAgentPlugin('paid-agent', 'paid-model'))
      await ctx.plugin({
        name: 'paid-model',
        inject: ['agentModels'],
        apply(pluginContext) {
          pluginContext.agentModels.register({
            id: 'paid-model',
            spendUnit: 'USD_MICRO',
            async generate() {
              return {
                message: { role: 'assistant', content: 'paid response' },
                spend: { unit: 'USD_MICRO', amount: 1n },
              }
            },
          })
        },
      })

      await expect(ctx.agentRuntime.run({ agentId: 'paid-agent', message: 'Hello' }))
        .rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

function createAgentPlugin(id: string, model: string) {
  return {
    name: `${id}-agent`,
    inject: ['agentRuntime', 'agentModels'],
    apply(ctx: CordisContext) {
      ctx.agentRuntime.registerAgent({ id, prompt: 'Test prompt', model }, ctx.agentModels)
    },
  }
}

function createModelPlugin(id: string, content: string) {
  return {
    name: `${id}-model`,
    inject: ['agentModels'],
    apply(ctx: CordisContext) {
      ctx.agentModels.register({
        id,
        async generate() {
          return { message: { role: 'assistant' as const, content } }
        },
      })
    },
  }
}

function createEntitlementPlugin(name: string, state: { spent: bigint, beforeRecord?: () => Promise<void> }) {
  return {
    name: `${name}-entitlement`,
    inject: ['entitlement'],
    apply(ctx: CordisContext) {
      ctx.entitlement.register({
        name,
        async status(account) {
          return { account, unit: 'USD_MICRO', limit: 100n, spent: state.spent }
        },
        async recordSpend(account, spend) {
          await state.beforeRecord?.()
          state.spent += spend.amount
          return { account, unit: spend.unit, limit: 100n, spent: state.spent }
        },
      })
    },
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(complete => {
    resolve = complete
  })
  return { promise, resolve }
}
