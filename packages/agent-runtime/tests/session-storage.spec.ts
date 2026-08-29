import AgentRuntime, { type ModelRequest } from '@karaka/agent-runtime'
import SessionStorage from '@karaka/agent-runtime/session-storage'
import Authentication from '@karaka/authentication'
import { authenticationHost, type HostPrincipal } from '@karaka/authentication/authentication-host'
import { Context, type Context as CordisContext } from '@karaka/cordis'
import Entitlement from '@karaka/entitlement'
import EntitlementLocal from '@karaka/entitlement/local'
import Storage, {
  StorageError,
  type StorageProvider,
  type StorageRecord,
} from '@karaka/storage'
import StorageLocal from '@karaka/storage/local'
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
    let principal: HostPrincipal = { tenantId: 'tenant-a', subject: 'user-a' }

    const first = await createRuntime(path, () => principal, 'Prompt v1', 'model-v1')
    let chatId: string
    try {
      const result = await first.ctx.agentRuntime.run({
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
      principal = { tenantId: 'tenant-a', subject: 'user-b' }
      await expect(second.ctx.agentRuntime.run({ chatId, message: 'Steal it' }))
        .rejects.toMatchObject({ code: 'CHAT_NOT_FOUND' })

      principal = { tenantId: 'tenant-a', subject: 'user-a' }
      await expect(second.ctx.agentRuntime.run({ chatId, message: 'Again' })).resolves.toMatchObject({
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
      await expect(second.ctx.agentRuntime.run({ chatId, message: 'Unavailable' }))
        .rejects.toMatchObject({ code: 'SESSION_UNAVAILABLE' })
    } finally {
      await second.ctx.fiber.dispose()
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
      await ctx.plugin(authenticationHost({
        currentPrincipal() {
          principalCalls++
          return { tenantId: 'tenant-a', subject: 'user-a' }
        },
      }))
      await ctx.plugin(Entitlement)
      await ctx.plugin(Storage)
      const originalPlugin = ctx.plugin(createStoragePlugin(original))
      await originalPlugin
      await ctx.plugin(AgentRuntime)
      await ctx.plugin(SessionStorage)
      await ctx.plugin(createAgentPlugin('Prompt', 'delayed-model'))
      await ctx.plugin({
        name: 'delayed-model',
        inject: ['agentRuntime'],
        apply(pluginContext) {
          pluginContext.agentRuntime.registerModel({
            id: 'delayed-model',
            async generate() {
              generationStarted.resolve()
              await finishGeneration.promise
              return { message: { role: 'assistant', content: 'Finished' } }
            },
          })
        },
      })

      const run = ctx.agentRuntime.run({ agentId: 'support', message: 'Hello', persist: true })
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
      await expect(ctx.agentRuntime.run({ agentId: 'support', message: 'New', persist: true }))
        .rejects.toMatchObject({ code: 'UNAVAILABLE' })

      await ctx.plugin(createStoragePlugin(replacement))
      finishGeneration.resolve()
      await expect(run).resolves.toMatchObject({ message: { content: 'Finished' } })
      await disposal

      expect(principalCalls).toBe(1)
      expect(original.updates).toBe(1)
      expect(replacement.creates).toBe(0)
      expect(replacement.updates).toBe(0)
    } finally {
      finishGeneration.resolve()
      await ctx.fiber.dispose()
    }
  })
})

async function createRuntime(
  path: string,
  currentPrincipal: () => HostPrincipal,
  prompt: string,
  model: string,
) {
  const ctx = new Context()
  const requests: ModelRequest[] = []
  await ctx.plugin(Authentication)
  await ctx.plugin(authenticationHost({ currentPrincipal }))
  await ctx.plugin(Entitlement)
  await ctx.plugin(EntitlementLocal, { defaultLimit: '100' })
  await ctx.plugin(Storage)
  await ctx.plugin(StorageLocal, { path })
  await ctx.plugin(AgentRuntime)
  const sessions = ctx.plugin(SessionStorage)
  await sessions
  await ctx.plugin(createAgentPlugin(prompt, model))
  await ctx.plugin(createModelPlugin(model, requests))
  return { ctx, requests, sessions }
}

function createAgentPlugin(prompt: string, model: string) {
  return {
    name: 'support-agent',
    inject: ['agentRuntime'],
    apply(ctx: CordisContext) {
      ctx.agentRuntime.registerAgent({ id: 'support', prompt, model })
    },
  }
}

function createModelPlugin(id: string, requests: ModelRequest[]) {
  return {
    name: id,
    inject: ['agentRuntime'],
    apply(ctx: CordisContext) {
      ctx.agentRuntime.registerModel({
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
