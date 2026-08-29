import AgentRuntime, { AgentRuntimeError } from '@karaka/agent-runtime'
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
        inject: ['agentRuntime'],
        apply(pluginContext) {
          pluginContext.agentRuntime.registerModel({
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
        inject: ['agentRuntime'],
        apply(pluginContext) {
          pluginContext.agentRuntime.registerModel({
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
        inject: ['agentRuntime'],
        apply(pluginContext) {
          pluginContext.agentRuntime.registerModel({
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

  it('requires an overall account for metered models', async () => {
    const ctx = new Context()

    try {
      await ctx.plugin(Entitlement)
      await ctx.plugin(EntitlementLocal, { defaultLimit: '100' })
      await ctx.plugin(AgentRuntime)
      await ctx.plugin(createAgentPlugin('paid-agent', 'paid-model'))
      await ctx.plugin({
        name: 'paid-model',
        inject: ['agentRuntime'],
        apply(pluginContext) {
          pluginContext.agentRuntime.registerModel({
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
    inject: ['agentRuntime'],
    apply(ctx: CordisContext) {
      ctx.agentRuntime.registerAgent({ id, prompt: 'Test prompt', model })
    },
  }
}
