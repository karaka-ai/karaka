import AgentRuntime, {
  type AgentChatResumeRequest,
  type AgentChatRunResult,
  type AgentChatStartRequest,
  type ModelRequest,
} from '@karaka/agent-runtime'
import SessionStorage from '@karaka/agent-runtime/session-storage'
import Authentication, { type TrustedUserContext } from '@karaka/authentication'
import { Context, type Context as CordisContext } from '@karaka/cordis'
import Entitlement from '@karaka/entitlement'
import EntitlementLocal from '@karaka/entitlement/local'
import Storage, {
  StorageError,
  type StorageProvider,
  type StorageRecord,
} from '@karaka/storage'
import StorageLocal from '@karaka/storage/local'
import ToolCore from '@karaka/tool/core'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

describe('Agent Runtime storage sessions', () => {
  const directories: string[] = []

  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
  })

  it('resumes durable history with the current agent graph and enforces canonical ownership', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'karaka-session-'))
    directories.push(directory)
    const path = join(directory, 'storage.sqlite')
    let principal: TrustedUserContext = { tenantId: 'tenant-a', userId: 'user-a' }

    const first = await createRuntime(path, () => principal, 'Prompt v1', 'model-v1')
    let chatId: string
    try {
      const result = await first.run({
        agentId: 'support',
        message: 'Hello',
        persist: true,
      })
      chatId = result.chatId
      expect(result).toMatchObject({ model: 'model-v1', message: { content: 'response from model-v1' } })
      expect(first.requests[0]?.messages).toEqual([
        { role: 'system', content: 'Prompt v1' },
        { role: 'user', content: 'Hello' },
      ])
      await expect(first.ctx.storage.read({
        namespace: 'agent-runtime.sessions',
        key: chatId,
      })).resolves.toMatchObject({
        value: {
          owner: { tenantId: 'tenant-a', subject: 'user-a' },
          entitlementAccount: '["tenant-a","user-a"]',
        },
      })
      await expect(first.ctx.entitlement.status('["tenant-a","user-a"]'))
        .resolves.toMatchObject({ spent: 1n })
    } finally {
      await first.ctx.fiber.dispose()
    }

    const second = await createRuntime(path, () => principal, 'Prompt v2', 'model-v2')
    try {
      principal = { tenantId: 'tenant-a', userId: 'user-b' }
      await expect(second.run({ chatId, message: 'Steal it' }))
        .rejects.toMatchObject({ code: 'CHAT_NOT_FOUND' })

      principal = { tenantId: 'tenant-a', userId: 'user-a' }
      await expect(second.run({ chatId, message: 'Again' })).resolves.toMatchObject({
        chatId,
        agentId: 'support',
        model: 'model-v2',
        message: { content: 'response from model-v2' },
      })
      expect(second.requests[0]?.messages).toEqual([
        { role: 'system', content: 'Prompt v2' },
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'response from model-v1' },
        { role: 'user', content: 'Again' },
      ])

      await second.sessions.dispose()
      await expect(second.run({ chatId, message: 'Unavailable' }))
        .rejects.toMatchObject({ code: 'SESSION_UNAVAILABLE' })
    } finally {
      await second.ctx.fiber.dispose()
    }
  })

  it.each([
    {
      schema: 1,
      messages: [
        { role: 'user', content: 'Legacy question' },
        { role: 'assistant', content: 'Legacy answer' },
      ],
    },
    {
      schema: 2,
      messages: [
        { role: 'user', content: 'Legacy tool question' },
        { type: 'tool-call', callId: 'legacy-call', toolId: 'legacy.tool', input: {} },
        { type: 'tool-result', callId: 'legacy-call', toolId: 'legacy.tool', output: {} },
        { role: 'assistant', content: 'Legacy tool answer' },
      ],
    },
  ])('reads and upgrades session schema $schema', async ({ schema, messages }) => {
    const directory = mkdtempSync(join(tmpdir(), `karaka-session-v${schema}-`))
    directories.push(directory)
    const runtime = await createRuntime(
      join(directory, 'storage.sqlite'),
      () => ({ tenantId: 'tenant-a', userId: 'user-a' }),
      'Current prompt',
      'current-model',
    )
    const chatId = `legacy-v${schema}`

    try {
      await runtime.ctx.storage.create({
        namespace: 'agent-runtime.sessions',
        key: chatId,
        value: {
          schema,
          owner: { tenantId: 'tenant-a', subject: 'user-a' },
          agentId: 'support',
          entitlementAccount: '["tenant-a","user-a"]',
          messages,
        },
      })

      await expect(runtime.run({ chatId, message: 'Continue' })).resolves.toMatchObject({ chatId })
      await expect(runtime.ctx.storage.read({ namespace: 'agent-runtime.sessions', key: chatId }))
        .resolves.toMatchObject({ value: { schema: 3 } })
    } finally {
      await runtime.ctx.fiber.dispose()
    }
  })

  it('keeps an in-flight durable turn bound to its original Storage provider', async () => {
    const ctx = new Context()
    const generationStarted = deferred<void>()
    const finishGeneration = deferred<void>()
    const original = new TrackingStorageProvider('original')
    const replacement = new TrackingStorageProvider('replacement')
    let principalCalls = 0

    try {
      await ctx.plugin(Authentication)
      await ctx.plugin(Entitlement)
      await ctx.plugin(Storage)
      const originalPlugin = ctx.plugin(createStoragePlugin(original))
      await originalPlugin
      await ctx.plugin(AgentRuntime)
      await ctx.plugin(SessionStorage)
      await ctx.plugin({
        name: 'delayed-model',
        inject: ['agentModels'],
        apply(pluginContext) {
          pluginContext.agentModels.register({
            id: 'delayed-model',
            async generate() {
              generationStarted.resolve()
              await finishGeneration.promise
              return { message: { role: 'assistant', content: 'Finished' } }
            },
          })
        },
      })
      await ctx.plugin(createAgentPlugin('Prompt', 'delayed-model'))

      const runAsUser = (request: Parameters<typeof ctx.agentRuntime.run>[0]) => {
        principalCalls++
        return ctx.authentication.withUser(
          { tenantId: 'tenant-a', userId: 'user-a' },
          testServer,
          () => ctx.agentRuntime.run(request),
        )
      }
      const run = runAsUser({ agentId: 'support', message: 'Hello', persist: true })
      await generationStarted.promise
      expect(original.creates).toBe(1)

      let disposalFinished = false
      const disposal = originalPlugin.dispose().then(() => {
        disposalFinished = true
      })
      await expect.poll(async () => {
        try {
          await ctx.storage.read({ namespace: 'tests', key: 'new' })
          return 'AVAILABLE'
        } catch (error) {
          return (error as { code?: string }).code
        }
      }).toBe('UNAVAILABLE')
      expect(disposalFinished).toBe(false)
      await expect(runAsUser({ agentId: 'support', message: 'New', persist: true }))
        .rejects.toMatchObject({ code: 'UNAVAILABLE' })

      await ctx.plugin(createStoragePlugin(replacement))
      finishGeneration.resolve()
      await expect(run).resolves.toMatchObject({ message: { content: 'Finished' } })
      await disposal

      expect(principalCalls).toBe(2)
      expect(original.updates).toBe(1)
      expect(replacement.creates).toBe(0)
      expect(replacement.updates).toBe(0)
    } finally {
      finishGeneration.resolve()
      await ctx.fiber.dispose()
    }
  })

  it('persists tool calls and results for later turns and process restarts', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'karaka-tool-session-'))
    directories.push(directory)
    const path = join(directory, 'storage.sqlite')

    const first = await createToolRuntime(path)
    let chatId: string
    try {
      const result = await first.run({ agentId: 'support', message: 'Double four', persist: true })
      chatId = result.chatId
      const stored = await first.ctx.storage.read({ namespace: 'agent-runtime.sessions', key: chatId })
      expect(stored?.value).toMatchObject({
        schema: 3,
        messages: [
          { role: 'system', content: 'Tool prompt' },
          { role: 'user', content: 'Double four' },
          {
            type: 'provider-item',
            providerData: { provider: 'test.provider', value: { reasoning: 'opaque' } },
          },
          {
            type: 'tool-call',
            callId: 'call-1',
            toolId: 'math.double',
            input: { value: 4 },
            providerData: { provider: 'test.provider', value: { nativeCall: 'call-1' } },
          },
          { type: 'tool-result', callId: 'call-1', toolId: 'math.double', output: { doubled: 8 } },
          { role: 'assistant', content: 'Eight.' },
        ],
      })
    } finally {
      await first.ctx.fiber.dispose()
    }

    const second = await createToolRuntime(path)
    try {
      await expect(second.run({ chatId, message: 'What happened?' })).resolves.toMatchObject({
        message: { content: 'Eight.' },
      })
      expect(second.requests[0]?.messages).toEqual([
        { role: 'system', content: 'Tool prompt' },
        { role: 'user', content: 'Double four' },
        {
          type: 'provider-item',
          providerData: { provider: 'test.provider', value: { reasoning: 'opaque' } },
        },
        {
          type: 'tool-call',
          callId: 'call-1',
          toolId: 'math.double',
          input: { value: 4 },
          providerData: { provider: 'test.provider', value: { nativeCall: 'call-1' } },
        },
        { type: 'tool-result', callId: 'call-1', toolId: 'math.double', output: { doubled: 8 } },
        { role: 'assistant', content: 'Eight.' },
        { role: 'user', content: 'What happened?' },
      ])

      const before = await second.ctx.storage.read({ namespace: 'agent-runtime.sessions', key: chatId })
      const invocations = second.invocations()
      await expect(second.run({ chatId, message: 'Repeat tool' }))
        .rejects.toMatchObject({ code: 'INVALID_MODEL_RESPONSE' })
      expect(second.invocations()).toBe(invocations)
      await expect(second.ctx.storage.read({ namespace: 'agent-runtime.sessions', key: chatId }))
        .resolves.toEqual(before)
      await expect(second.run({ chatId, message: 'Still readable?' })).resolves.toMatchObject({
        message: { content: 'Eight.' },
      })
    } finally {
      await second.ctx.fiber.dispose()
    }
  })
})

async function createRuntime(
  path: string,
  currentPrincipal: () => TrustedUserContext,
  prompt: string,
  model: string,
) {
  const ctx = new Context()
  const requests: ModelRequest[] = []
  await ctx.plugin(Authentication)
  await ctx.plugin(Entitlement)
  await ctx.plugin(EntitlementLocal, { defaultLimit: '100' })
  await ctx.plugin(Storage)
  await ctx.plugin(StorageLocal, { path })
  await ctx.plugin(AgentRuntime)
  const sessions = ctx.plugin(SessionStorage)
  await sessions
  await ctx.plugin(createModelPlugin(model, requests))
  await ctx.plugin(createAgentPlugin(prompt, model))
  const run = (request: AgentChatStartRequest | AgentChatResumeRequest): Promise<AgentChatRunResult> => {
    return ctx.authentication.withUser(currentPrincipal(), testServer, () => ctx.agentRuntime.run(request))
  }
  return { ctx, requests, sessions, run }
}

const testServer = Object.freeze({ id: 'test-application', provider: 'test', claims: Object.freeze({}) })

function createAgentPlugin(prompt: string, model: string) {
  return {
    name: 'support-agent',
    inject: ['agentRuntime', 'agentModels'],
    apply(ctx: CordisContext) {
      ctx.agentRuntime.registerAgent({ id: 'support', prompt, model }, ctx.agentModels)
    },
  }
}

function createModelPlugin(id: string, requests: ModelRequest[]) {
  return {
    name: id,
    inject: ['agentModels'],
    apply(ctx: CordisContext) {
      ctx.agentModels.register({
        id,
        spendUnit: 'USD_MICRO',
        async generate(request) {
          requests.push(request)
          return {
            message: { role: 'assistant', content: `response from ${id}` },
            spend: { unit: 'USD_MICRO', amount: 1n },
          }
        },
      })
    },
  }
}

async function createToolRuntime(path: string) {
  const ctx = new Context()
  const requests: ModelRequest[] = []
  let invocations = 0
  await ctx.plugin(Authentication)
  await ctx.plugin(Entitlement)
  await ctx.plugin(Storage)
  await ctx.plugin(StorageLocal, { path })
  await ctx.plugin(AgentRuntime)
  await ctx.plugin(SessionStorage)
  await ctx.plugin(ToolCore)
  await ctx.plugin({
    name: 'math-double-tool',
    inject: ['tools'],
    apply(pluginContext) {
      pluginContext.tools.register({
        descriptor: {
          id: 'math.double',
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
        invoke(input) {
          invocations++
          return { doubled: (input as { readonly value: number }).value * 2 }
        },
      })
    },
  })
  await ctx.plugin({
    name: 'tool-model',
    inject: ['agentModels'],
    apply(pluginContext) {
      pluginContext.agentModels.register({
        id: 'tool-model',
        validateTools() {},
        async generate(request) {
          requests.push(request)
          const lastUser = request.messages.findLast(item => !('type' in item) && item.role === 'user')
          if (lastUser && !('type' in lastUser) && lastUser.content === 'Repeat tool') {
            return {
              message: { role: 'assistant', content: '' },
              toolCalls: [{
                type: 'tool-call',
                callId: 'call-1',
                toolId: 'math.double',
                input: { value: 5 },
              }],
            }
          }
          const hasResult = request.messages.some(item => 'type' in item && item.type === 'tool-result')
          if (!hasResult) {
            const call = {
              type: 'tool-call' as const,
              callId: 'call-1',
              toolId: 'math.double',
              input: { value: 4 },
              providerData: {
                provider: 'test.provider',
                value: { nativeCall: 'call-1' },
              },
            }
            return {
              message: { role: 'assistant', content: '' },
              toolCalls: [call],
              replay: [{
                type: 'provider-item' as const,
                providerData: {
                  provider: 'test.provider',
                  value: { reasoning: 'opaque' },
                },
              }, call],
            }
          }
          return { message: { role: 'assistant', content: 'Eight.' } }
        },
      })
    },
  })
  await ctx.plugin({
    name: 'tool-agent',
    inject: ['agentRuntime', 'agentModels', 'tools'],
    apply(pluginContext) {
      pluginContext.agentRuntime.registerAgent({
        id: 'support',
        prompt: 'Tool prompt',
        model: 'tool-model',
        tools: ['math.double'],
      }, pluginContext.agentModels, pluginContext.tools)
    },
  })
  const run = (request: AgentChatStartRequest | AgentChatResumeRequest): Promise<AgentChatRunResult> => {
    return ctx.authentication.withUser(
      { tenantId: 'tenant-a', userId: 'user-a' },
      testServer,
      () => ctx.agentRuntime.run(request),
    )
  }
  return { ctx, requests, run, invocations: () => invocations }
}

class TrackingStorageProvider implements StorageProvider {
  readonly records = new Map<string, StorageRecord>()
  creates = 0
  updates = 0

  constructor(readonly name: string) {}

  async read(key: { namespace: string, key: string }) {
    return this.records.get(recordKey(key))
  }

  async create(record: { namespace: string, key: string, value: StorageRecord['value'] }) {
    const key = recordKey(record)
    if (this.records.has(key)) throw new StorageError('ALREADY_EXISTS', 'record exists')
    const created = { ...record, version: 1 }
    this.records.set(key, created)
    this.creates++
    return created
  }

  async update(record: {
    namespace: string
    key: string
    value: StorageRecord['value']
    expectedVersion: number
  }) {
    const key = recordKey(record)
    const current = this.records.get(key)
    if (!current) throw new StorageError('NOT_FOUND', 'record does not exist')
    if (current.version !== record.expectedVersion) throw new StorageError('CONFLICT', 'record changed')
    const updated = { namespace: record.namespace, key: record.key, value: record.value, version: current.version + 1 }
    this.records.set(key, updated)
    this.updates++
    return updated
  }
}

function createStoragePlugin(provider: StorageProvider) {
  return {
    name: `${provider.name}-storage`,
    inject: ['storage'],
    apply(ctx: CordisContext) {
      ctx.storage.register(provider)
    },
  }
}

function recordKey(record: { namespace: string, key: string }) {
  return JSON.stringify([record.namespace, record.key])
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(complete => {
    resolve = complete
  })
  return { promise, resolve }
}
