import type { AuthenticatedIdentity } from '@karaka/authentication'
import type { Context } from '@karaka/cordis'
import Schema from '@karaka/schemastery'
import {
  StorageError,
  type StorageLease,
  type StorageRecord,
  type StorageValue,
} from '@karaka/storage'
import { randomUUID } from 'node:crypto'
import {
  AgentRuntimeError,
  type AgentSession,
  type AgentSessionLease,
  type AgentSessionOpenRequest,
  type AgentSessionOwner,
  type AgentSessionProvider,
  type ModelConversationItem,
  type ModelMessage,
} from './index.ts'

/** YAML-serializable namespace for Agent Runtime session records. */
export interface Config {
  namespace?: string
}

export const Config: Schema<Config> = Schema.object({
  namespace: Schema.string().default('agent-runtime.sessions'),
})

interface StoredSession {
  readonly schema: 2
  readonly owner: AgentSessionOwner
  readonly agentId: string
  readonly entitlementAccount: string
  readonly messages: readonly ModelConversationItem[]
}

/** Durable session behavior backed by the provider-neutral Storage seam. */
class StorageSessionProvider implements AgentSessionProvider {
  readonly name = 'storage'

  constructor(private readonly ctx: Context, private readonly namespace: string) {}

  async withSession<T>(
    request: Readonly<AgentSessionOpenRequest>,
    operation: (session: AgentSessionLease) => T | Promise<T>,
  ): Promise<T> {
    return this.ctx.storage.withProvider(async storage => {
      const principal = await this.ctx.authentication.currentPrincipal()
      const session = 'chatId' in request
        ? await this.load(storage, principal, request.chatId)
        : await this.create(storage, principal, request.agentId)
      let active = true
      let committed = false
      const lease: AgentSessionLease = Object.freeze({
        session,
        commit: async (messages: readonly ModelConversationItem[]) => {
          if (!active) throw new AgentRuntimeError('SESSION_UNAVAILABLE', 'agent session lease is no longer active')
          if (committed) throw new AgentRuntimeError('SESSION_CONFLICT', 'chat turn is already committed')
          committed = true
          return this.update(storage, session, messages)
        },
      })

      try {
        return await operation(lease)
      } finally {
        active = false
      }
    })
  }

  private async create(storage: StorageLease, principal: AuthenticatedIdentity, agentId: string) {
    const owner = ownerOf(principal)
    const session: StoredSession = {
      schema: 2,
      owner,
      agentId,
      entitlementAccount: entitlementAccountOf(owner),
      messages: [],
    }
    const id = randomUUID()
    return decode(await storage.create({
      namespace: this.namespace,
      key: id,
      value: encode(session),
    }))
  }

  private async load(storage: StorageLease, principal: AuthenticatedIdentity, chatId: string) {
    const record = await storage.read({ namespace: this.namespace, key: chatId })
    if (!record) throw chatNotFound()
    const session = decode(record)
    assertOwner(session.owner, principal)
    return session
  }

  private async update(storage: StorageLease, session: AgentSession, messages: readonly ModelConversationItem[]) {
    try {
      const updated = await storage.update({
        namespace: this.namespace,
        key: session.id,
        expectedVersion: session.version,
        value: encode({
          schema: 2,
          owner: session.owner,
          agentId: session.agentId,
          entitlementAccount: session.entitlementAccount,
          messages,
        }),
      })
      return decode(updated)
    } catch (error) {
      if (error instanceof StorageError && error.code === 'CONFLICT') {
        throw new AgentRuntimeError('SESSION_CONFLICT', 'chat changed during the turn', { cause: error })
      }
      if (error instanceof StorageError && error.code === 'NOT_FOUND') throw chatNotFound(error)
      throw error
    }
  }
}

/** Install durable Agent Runtime sessions using Authentication and Storage. */
export const plugin = {
  name: 'agent-runtime-session-storage',
  inject: ['agentRuntime', 'authentication', 'storage'],
  Config,
  apply(ctx: Context, config: Config) {
    const namespace = requireText(config.namespace ?? 'agent-runtime.sessions', 'session namespace')
    ctx.agentRuntime.registerSessionProvider(new StorageSessionProvider(ctx, namespace))
  },
}

function encode(session: StoredSession): StorageValue {
  return {
    schema: session.schema,
    owner: { tenantId: session.owner.tenantId, subject: session.owner.subject },
    agentId: session.agentId,
    entitlementAccount: session.entitlementAccount,
    messages: session.messages.map(encodeConversationItem),
  }
}

function decode(record: StorageRecord): AgentSession {
  try {
    if (!record.value || typeof record.value !== 'object' || Array.isArray(record.value)) {
      throw new TypeError('session value must be an object')
    }
    const value = record.value as Record<string, StorageValue>
    if (value.schema !== 1 && value.schema !== 2) throw new TypeError('unsupported session schema')
    if (!value.owner || typeof value.owner !== 'object' || Array.isArray(value.owner)) {
      throw new TypeError('session owner must be an object')
    }
    const ownerValue = value.owner as Record<string, StorageValue>
    const owner = Object.freeze({
      tenantId: requireText(ownerValue.tenantId, 'session tenant ID'),
      subject: requireText(ownerValue.subject, 'session subject'),
    })
    const messages = decodeMessages(value.messages, value.schema === 2)
    return Object.freeze({
      id: record.key,
      owner,
      agentId: requireText(value.agentId, 'session agent ID'),
      entitlementAccount: requireText(value.entitlementAccount, 'session entitlement account'),
      messages,
      version: record.version,
    })
  } catch (error) {
    if (error instanceof AgentRuntimeError) throw error
    throw new AgentRuntimeError('INVALID_SESSION', 'stored chat state is invalid', { cause: error })
  }
}

function decodeMessages(value: StorageValue | undefined, allowTools: boolean): readonly ModelConversationItem[] {
  if (!Array.isArray(value)) throw new TypeError('session messages must be an array')
  const calls = new Map<string, string>()
  const results = new Set<string>()
  const messages = value.map((message, index) => {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      throw new TypeError('session message must be an object')
    }
    const item = message as Record<string, StorageValue>
    if (item.type === undefined) {
      if (
        !['system', 'user', 'assistant'].includes(item.role as string)
        || typeof item.content !== 'string'
        || (item.role === 'system' && index !== 0)
      ) {
        throw new TypeError('session message is invalid')
      }
      return Object.freeze({ role: item.role as ModelMessage['role'], content: item.content })
    }
    if (!allowTools) throw new TypeError('legacy session contains a tool item')
    if (item.type === 'tool-call') {
      const callId = requireText(item.callId, 'tool call ID')
      const toolId = requireText(item.toolId, 'tool ID')
      if (calls.has(callId) || item.input === undefined) throw new TypeError('session tool call is invalid')
      calls.set(callId, toolId)
      return Object.freeze({ type: 'tool-call' as const, callId, toolId, input: item.input })
    }
    if (item.type === 'tool-result') {
      const callId = requireText(item.callId, 'tool result call ID')
      const toolId = requireText(item.toolId, 'tool ID')
      if (calls.get(callId) !== toolId || results.has(callId) || item.output === undefined) {
        throw new TypeError('session tool result is invalid')
      }
      results.add(callId)
      return Object.freeze({ type: 'tool-result' as const, callId, toolId, output: item.output })
    }
    throw new TypeError('session conversation item is invalid')
  })
  if (calls.size !== results.size) throw new TypeError('session contains a tool call without a result')
  return Object.freeze(messages)
}

function encodeConversationItem(item: ModelConversationItem): StorageValue {
  if (!('type' in item)) return { role: item.role, content: item.content }
  if (item.type === 'tool-call') {
    return { type: item.type, callId: item.callId, toolId: item.toolId, input: item.input }
  }
  return { type: item.type, callId: item.callId, toolId: item.toolId, output: item.output }
}

function assertOwner(owner: AgentSessionOwner, principal: AuthenticatedIdentity) {
  if (owner.tenantId !== principal.tenantId || owner.subject !== principal.subject) throw chatNotFound()
}

function ownerOf(principal: AuthenticatedIdentity): AgentSessionOwner {
  return Object.freeze({ tenantId: principal.tenantId, subject: principal.subject })
}

function entitlementAccountOf(owner: AgentSessionOwner) {
  return JSON.stringify([owner.tenantId, owner.subject])
}

function chatNotFound(cause?: unknown) {
  return new AgentRuntimeError('CHAT_NOT_FOUND', 'chat is not available', cause === undefined ? undefined : { cause })
}

function requireText(value: unknown, label: string): string {
  if (typeof value === 'string' && value.trim()) return value
  throw new TypeError(`${label} must be a non-empty string`)
}

export default plugin
