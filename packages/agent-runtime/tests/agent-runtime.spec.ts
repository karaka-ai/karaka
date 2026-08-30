import AgentRuntime, {
  AgentModelsService,
  AgentRuntimeError,
  type ModelRequest,
} from '@karaka/agent-runtime'
import EchoModel from '@karaka/agent-runtime/model-echo'
import { Context, type Context as CordisContext } from '@karaka/cordis'
import Entitlement from '@karaka/entitlement'
import EntitlementLocal from '@karaka/entitlement/local'
import Include from '@karaka/cordis-plugin-include'
import Loader from '@karaka/cordis-plugin-loader'
import type { ToolDescriptor } from '@karaka/sdk'
import ToolCore, { type ToolContribution } from '@karaka/tool/core'
import { describe, expect, it } from 'vitest'

describe('Agent Runtime', () => {
  it('forwards cancellation to non-streaming model calls', async () => {
    const ctx = new Context()
    const started = Promise.withResolvers<void>()
    let observedSignal: AbortSignal | undefined

    try {
      await ctx.plugin(Entitlement)
      await ctx.plugin(AgentRuntime)
      await ctx.plugin({
        name: 'cancellable-model',
        inject: ['agentModels'],
        apply(pluginContext) {
          pluginContext.agentModels.register({
            id: 'cancel-model',
            async generate(request) {
              observedSignal = request.signal
              started.resolve()
              return new Promise<never>((_resolve, reject) => {
                request.signal?.addEventListener('abort', () => reject(request.signal?.reason), { once: true })
              })
            },
          })
        },
      })
      await ctx.plugin(createAgentPlugin('cancel-agent', 'cancel-model'))

      const controller = new AbortController()
      const run = ctx.agentRuntime.run(
        { agentId: 'cancel-agent', message: 'Wait' },
        { signal: controller.signal },
      )
      await started.promise
      controller.abort(new Error('caller disconnected'))

      await expect(run).rejects.toMatchObject({ code: 'ABORTED' })
      expect(observedSignal).toBe(controller.signal)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('emits provider-neutral incremental text while returning the completed turn', async () => {
    const ctx = new Context()

    try {
      await ctx.plugin(Entitlement)
      await ctx.plugin(AgentRuntime)
      await ctx.plugin(EchoModel, { id: 'stream-model', prefix: 'Received: ' })
      await ctx.plugin(createAgentPlugin('stream-agent', 'stream-model'))
      const events: Array<{ type: 'text-delta', delta: string }> = []

      const result = await ctx.agentRuntime.stream({
        agentId: 'stream-agent',
        message: 'Hello',
      }, event => {
        events.push(event)
      })

      expect(events).toEqual([
        { type: 'text-delta', delta: 'Received: ' },
        { type: 'text-delta', delta: 'Hello' },
      ])
      expect(result).toEqual({
        agentId: 'stream-agent',
        model: 'stream-model',
        message: { role: 'assistant', content: 'Received: Hello' },
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

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
      await ctx.serial('karaka/ready')

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

  it('validates model and tool dependencies while an agent activates', async () => {
    const ctx = new Context()
    let validated = 0

    try {
      await ctx.plugin(Entitlement)
      await ctx.plugin(AgentRuntime)
      await ctx.plugin(ToolCore)

      const missingModel = ctx.plugin(createAgentPlugin('missing-model-agent', 'missing-model'))
      await missingModel
      expect(() => ctx.agentRuntime.assertReady()).toThrow(expect.objectContaining({ code: 'INVALID_AGENT' }))
      await missingModel.dispose()

      await ctx.plugin(createModelPlugin('tool-model', 'unused', tools => {
        validated++
        expect(tools.map(tool => tool.id)).toEqual(['math.double'])
      }))
      const missingTool = ctx.plugin(createAgentPlugin('missing-tool-agent', 'tool-model', ['math.double']))
      await missingTool
      expect(() => ctx.agentRuntime.assertReady()).toThrow(expect.objectContaining({ code: 'INVALID_AGENT' }))
      await missingTool.dispose()

      await ctx.plugin(createToolPlugin('math.double', input => ({
        doubled: (input as { readonly value: number }).value * 2,
      })))
      await ctx.plugin(createAgentPlugin('ready-agent', 'tool-model', ['math.double']))

      expect(validated).toBe(1)
      expect(ctx.agentRuntime.listAgents()).toContainEqual({
        id: 'ready-agent',
        prompt: 'Test prompt',
        model: 'tool-model',
        tools: ['math.double'],
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('executes validated model tool calls and returns their results to the model', async () => {
    const ctx = new Context()
    const requests: ModelRequest[] = []
    let invocations = 0

    try {
      await ctx.plugin(Entitlement)
      await ctx.plugin(AgentRuntime)
      await ctx.plugin(ToolCore)
      await ctx.plugin(createToolPlugin('math.double', input => {
        invocations++
        return { doubled: (input as { readonly value: number }).value * 2 }
      }))
      await ctx.plugin({
        name: 'tool-calling-model',
        inject: ['agentModels'],
        apply(pluginContext) {
          pluginContext.agentModels.register({
            id: 'tool-model',
            validateTools() {},
            async generate(request) {
              requests.push(request)
              if (requests.length === 1) {
                return {
                  message: { role: 'assistant', content: '' },
                  toolCalls: [{
                    type: 'tool-call',
                    callId: 'call-1',
                    toolId: 'math.double',
                    input: { value: 4 },
                  }],
                }
              }
              return { message: { role: 'assistant', content: 'The answer is 8.' } }
            },
          })
        },
      })
      await ctx.plugin(createAgentPlugin('tool-agent', 'tool-model', ['math.double']))

      await expect(ctx.agentRuntime.run({ agentId: 'tool-agent', message: 'Double four' })).resolves.toEqual({
        agentId: 'tool-agent',
        model: 'tool-model',
        message: { role: 'assistant', content: 'The answer is 8.' },
      })
      expect(invocations).toBe(1)
      expect(requests[0]?.tools).toEqual([expect.objectContaining({ id: 'math.double' })])
      expect(requests[1]?.messages).toEqual([
        { role: 'system', content: 'Test prompt' },
        { role: 'user', content: 'Double four' },
        { type: 'tool-call', callId: 'call-1', toolId: 'math.double', input: { value: 4 } },
        { type: 'tool-result', callId: 'call-1', toolId: 'math.double', output: { doubled: 8 } },
      ])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('rejects malformed model tool arguments before invoking application code', async () => {
    const ctx = new Context()
    let invoked = false

    try {
      await ctx.plugin(Entitlement)
      await ctx.plugin(AgentRuntime)
      await ctx.plugin(ToolCore)
      await ctx.plugin(createToolPlugin('math.double', () => {
        invoked = true
        return { doubled: 0 }
      }))
      await ctx.plugin({
        name: 'invalid-tool-input-model',
        inject: ['agentModels'],
        apply(pluginContext) {
          pluginContext.agentModels.register({
            id: 'invalid-tool-model',
            validateTools() {},
            async generate() {
              return {
                message: { role: 'assistant', content: '' },
                toolCalls: [{
                  type: 'tool-call',
                  callId: 'call-1',
                  toolId: 'math.double',
                  input: { value: 'four' },
                }],
              }
            },
          })
        },
      })
      await ctx.plugin(createAgentPlugin('invalid-tool-agent', 'invalid-tool-model', ['math.double']))

      await expect(ctx.agentRuntime.run({ agentId: 'invalid-tool-agent', message: 'Double four' }))
        .rejects.toMatchObject({ code: 'INVALID_INPUT' })
      expect(invoked).toBe(false)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('continues a streamed turn after a model tool call', async () => {
    const ctx = new Context()
    let generations = 0

    try {
      await ctx.plugin(Entitlement)
      await ctx.plugin(AgentRuntime)
      await ctx.plugin(ToolCore)
      await ctx.plugin(createToolPlugin('math.double', input => ({
        doubled: (input as { readonly value: number }).value * 2,
      })))
      await ctx.plugin({
        name: 'streaming-tool-model',
        inject: ['agentModels'],
        apply(pluginContext) {
          pluginContext.agentModels.register({
            id: 'streaming-tool-model',
            validateTools() {},
            async generate() {
              throw new Error('stream path expected')
            },
            async *stream() {
              generations++
              if (generations === 1) {
                yield {
                  type: 'completed' as const,
                  generation: {
                    message: { role: 'assistant' as const, content: '' },
                    toolCalls: [{
                      type: 'tool-call' as const,
                      callId: 'call-1',
                      toolId: 'math.double',
                      input: { value: 4 },
                    }],
                  },
                }
                return
              }
              yield { type: 'text-delta' as const, delta: 'Eight' }
              yield { type: 'text-delta' as const, delta: '.' }
              yield {
                type: 'completed' as const,
                generation: { message: { role: 'assistant' as const, content: 'Eight.' } },
              }
            },
          })
        },
      })
      await ctx.plugin(createAgentPlugin('streaming-tool-agent', 'streaming-tool-model', ['math.double']))
      const events: Array<{ type: 'text-delta', delta: string }> = []

      await expect(ctx.agentRuntime.stream(
        { agentId: 'streaming-tool-agent', message: 'Double four' },
        event => {
          events.push(event)
        },
      )).resolves.toMatchObject({ message: { content: 'Eight.' } })
      expect(events).toEqual([
        { type: 'text-delta', delta: 'Eight' },
        { type: 'text-delta', delta: '.' },
      ])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('retains one immutable agent snapshot while its plugins unload', async () => {
    const ctx = new Context()
    const toolStarted = deferred<void>()
    const finishTool = deferred<void>()
    let generations = 0

    try {
      await ctx.plugin(Entitlement)
      await ctx.plugin(AgentRuntime)
      await ctx.plugin(ToolCore)
      const tool = ctx.plugin(createToolPlugin('math.double', async input => {
        toolStarted.resolve()
        await finishTool.promise
        return { doubled: (input as { readonly value: number }).value * 2 }
      }))
      await tool
      const model = ctx.plugin({
        name: 'leased-model',
        inject: ['agentModels'],
        apply(pluginContext) {
          pluginContext.agentModels.register({
            id: 'leased-model',
            validateTools() {},
            async generate() {
              generations++
              if (generations === 1) {
                return {
                  message: { role: 'assistant', content: '' },
                  toolCalls: [{
                    type: 'tool-call',
                    callId: 'call-1',
                    toolId: 'math.double',
                    input: { value: 3 },
                  }],
                }
              }
              return { message: { role: 'assistant', content: 'Six.' } }
            },
          })
        },
      })
      await model
      const agent = ctx.plugin(createAgentPlugin('leased-agent', 'leased-model', ['math.double']))
      await agent

      const run = ctx.agentRuntime.run({ agentId: 'leased-agent', message: 'Double three' })
      await toolStarted.promise
      const disposals = [agent.dispose(), model.dispose(), tool.dispose()]
      await expect.poll(() => ctx.agentRuntime.listAgents()).toEqual([])
      await expect(ctx.agentRuntime.run({ agentId: 'leased-agent', message: 'New turn' }))
        .rejects.toMatchObject({ code: 'UNKNOWN_AGENT' })
      expect(await Promise.race([
        Promise.all(disposals).then(() => 'disposed'),
        Promise.resolve('retained'),
      ])).toBe('retained')

      finishTool.resolve()
      await expect(run).resolves.toMatchObject({ message: { content: 'Six.' } })
      await Promise.all(disposals)
      expect(generations).toBe(2)
    } finally {
      finishTool.resolve()
      await ctx.fiber.dispose()
    }
  })

  it('removes agent and model contributions with their plugins', async () => {
    const ctx = new Context()

    try {
      await ctx.plugin(Entitlement)
      await ctx.plugin(AgentRuntime)
      const model = ctx.plugin(EchoModel, { id: 'test-model' })
      await model
      const agent = ctx.plugin(createAgentPlugin('test-agent', 'test-model'))
      await agent

      expect(ctx.agentRuntime.listAgents()).toEqual([
        { id: 'test-agent', prompt: 'Test prompt', model: 'test-model' },
      ])
      expect(ctx.agentRuntime.listModels()).toEqual(['test-model'])

      await model.dispose()
      expect(ctx.agentRuntime.listAgents()).toEqual([])
      await expect(ctx.agentRuntime.run({ agentId: 'test-agent', message: 'Hello' }))
        .rejects.toMatchObject({ code: 'INVALID_AGENT' })

      const replacement = ctx.plugin(EchoModel, { id: 'test-model', prefix: 'New: ' })
      await replacement
      expect(ctx.agentRuntime.listAgents()).toEqual([
        { id: 'test-agent', prompt: 'Test prompt', model: 'test-model' },
      ])
      await expect(ctx.agentRuntime.run({ agentId: 'test-agent', message: 'Hello' }))
        .resolves.toMatchObject({ message: { content: 'New: Hello' } })

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
        .rejects.toMatchObject({ code: 'INVALID_AGENT' })
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
      await ctx.plugin(createAgentPlugin('broken-agent', 'broken-model'))

      await expect(ctx.agentRuntime.run({ agentId: 'broken-agent', message: 'Hello' }))
        .rejects.toMatchObject({ code: 'INVALID_MODEL_RESPONSE' })

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
      await ctx.plugin(createAgentPlugin('hidden-spend-agent', 'hidden-spend-model'))

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
      await ctx.plugin(createAgentPlugin('paid-agent', 'paid-model'))

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
      await ctx.plugin(createAgentPlugin('invalid-agent', 'invalid-model'))

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
      await ctx.plugin(createAgentPlugin('paid-agent', 'paid-model'))

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
      await ctx.plugin(createAgentPlugin('paid-agent', 'paid-model'))

      await expect(ctx.agentRuntime.run({ agentId: 'paid-agent', message: 'Hello' }))
        .rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

function createAgentPlugin(id: string, model: string, tools?: readonly string[]) {
  return {
    name: `${id}-agent`,
    inject: tools?.length ? ['agentRuntime', 'agentModels', 'tools'] : ['agentRuntime', 'agentModels'],
    apply(ctx: CordisContext) {
      ctx.agentRuntime.registerAgent(
        { id, prompt: 'Test prompt', model, ...(tools === undefined ? {} : { tools }) },
        ctx.agentModels,
        tools?.length ? ctx.tools : undefined,
      )
    },
  }
}

function createModelPlugin(
  id: string,
  content: string,
  validateTools?: (tools: readonly ToolDescriptor[]) => void,
) {
  return {
    name: `${id}-model`,
    inject: ['agentModels'],
    apply(ctx: CordisContext) {
      ctx.agentModels.register({
        id,
        ...(validateTools ? { validateTools } : {}),
        async generate() {
          return { message: { role: 'assistant' as const, content } }
        },
      })
    },
  }
}

function createToolPlugin(id: string, invoke: ToolContribution['invoke']) {
  return {
    name: `${id}-tool`,
    inject: ['tools'],
    apply(ctx: CordisContext) {
      ctx.tools.register({
        descriptor: {
          id,
          description: 'Double one integer.',
          input: {
            type: 'object',
            properties: { value: { type: 'integer' } },
            required: ['value'],
            additionalProperties: false,
          },
          output: {
            type: 'object',
            properties: { doubled: { type: 'integer' } },
            required: ['doubled'],
            additionalProperties: false,
          },
        },
        invoke,
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
