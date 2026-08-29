import AgentRuntime, { AgentRuntimeError } from '@karaka/agent-runtime'
import AgentDefinition from '@karaka/agent-runtime/agent'
import EchoModel from '@karaka/agent-runtime/model-echo'
import { Context } from '@karaka/cordis'
import Include from '@karaka/cordis-plugin-include'
import Loader from '@karaka/cordis-plugin-loader'
import { describe, expect, it } from 'vitest'

describe('Agent Runtime', () => {
  it('composes a single-turn runtime from YAML', async () => {
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
      await ctx.plugin(AgentRuntime)
      const model = ctx.plugin(EchoModel, { id: 'test-model' })
      const agent = ctx.plugin(AgentDefinition, {
        id: 'test-agent',
        prompt: 'Test prompt',
        model: 'test-model',
      })
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
      await ctx.plugin(AgentRuntime)
      await expect(ctx.agentRuntime.run({ agentId: '', message: 'Hello' })).rejects.toEqual(
        expect.objectContaining<Partial<AgentRuntimeError>>({ code: 'INVALID_REQUEST' }),
      )

      await ctx.plugin(AgentDefinition, {
        id: 'broken-agent',
        prompt: 'Test prompt',
        model: 'broken-model',
      })
      await ctx.plugin({
        name: 'broken-model',
        inject: ['agentRuntime'],
        apply(pluginContext) {
          pluginContext.agentRuntime.registerModel({
            id: 'broken-model',
            async generate() {
              return { role: 'user', content: 'not an assistant response' }
            },
          })
        },
      })

      await expect(ctx.agentRuntime.run({ agentId: 'broken-agent', message: 'Hello' }))
        .rejects.toMatchObject({ code: 'INVALID_MODEL_RESPONSE' })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
