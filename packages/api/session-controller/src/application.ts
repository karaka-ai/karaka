/** Host-only application chat operations over DSH Sessions and Agents. */

import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type { ApplicationOwner, SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type { SessionFollowFrame, SessionRequestId, SessionWireEvent } from './types.ts'
import type { ModelSelection, PromptContentPart } from './types.ts'
import {
  ApiSessionAgentController,
  ApiSessionApplicationOwnerConflict,
  applicationOwnerEquals,
} from './agent.ts'
import { SessionCommandController } from './commands.ts'
import { SessionEventFollower } from './follow.ts'

/** Stable application-facing Agent roster row. */
export interface ApplicationAgentRow {
  readonly id: string
  readonly name: string
  readonly description?: string
}

/** Application chat creation input after server authentication. */
export interface ApplicationChatCreate {
  readonly chatId: SessionId
  readonly agentId: string
  readonly owner: ApplicationOwner
}

/** Application chat message admission input after server authentication. */
export interface ApplicationChatPrompt {
  readonly chatId: SessionId
  readonly requestId: string
  readonly owner: ApplicationOwner
  readonly content: readonly PromptContentPart[]
}

/** Application chat operation identity after server authentication. */
export interface ApplicationChatAddress {
  readonly chatId: SessionId
  readonly owner: ApplicationOwner
}

/** Host-only application API built from existing Session Controller components. */
export class ApplicationChatController {
  private readonly sessions: Context['sessions']
  private readonly sessionQuery: Context['sessionQuery']
  private readonly admissions = new Map<SessionId, Promise<void>>()
  private readonly operations = new Set<Promise<unknown>>()
  private readonly closeFollowers = new Set<() => void>()
  private closing = false

  constructor(
    private readonly ctx: Context,
    private readonly agents: ApiSessionAgentController,
    private readonly commands: SessionCommandController,
  ) {
    this.sessions = ctx.sessions
    this.sessionQuery = ctx.sessionQuery
    ctx.effect(() => () => {
      for (const close of this.closeFollowers) close()
      this.closeFollowers.clear()
    }, 'session-controller.application-followers')
    ctx.effect(() => async () => {
      this.closing = true
      await Promise.allSettled([...this.operations])
    }, 'session-controller.application-operations')
  }

  /**
   * List every usable Agent Preset without Host paths or trust metadata.
   * @param signal - optional caller cancellation.
   * @returns stable application-facing Agent rows.
   */
  async listAgents(signal?: AbortSignal): Promise<readonly ApplicationAgentRow[]> {
    signal?.throwIfAborted()
    const presets = this.ctx.get('agentPresets')
    if (presets === undefined) return []
    const listed = await presets.list()
    signal?.throwIfAborted()
    return listed
      .filter(preset => preset.broken === undefined)
      .map(preset => ({
        id: preset.id,
        name: preset.name ?? preset.id,
        ...(preset.description === undefined ? {} : { description: preset.description }),
      }))
  }

  /**
   * Create or idempotently adopt one workspace-free application chat.
   * @param request - authenticated owner, chat identity, and Agent Preset.
   * @param signal - optional caller cancellation.
   * @returns the accepted chat and Agent identities.
   */
  async create(
    request: ApplicationChatCreate,
    signal?: AbortSignal,
  ): Promise<{ readonly chatId: SessionId; readonly agentId: string }> {
    this.assertOpen()
    signal?.throwIfAborted()
    return this.track((async () => {
      try {
        const persistence = this.ctx.get('sessionPersistence')
        if (persistence === undefined) throw new Error('application chats require session persistence')
        const agent = await this.agents.ensureSession(
          request.chatId, undefined, true, request.agentId, request.owner,
        )
        const release = this.agents.pinApplication(agent)
        try {
          await persistence.ensureMaterialized(agent.session)
          this.agents.touchApplication(agent)
        } finally {
          release()
        }
      } catch (error: unknown) {
        if (error instanceof ApiSessionApplicationOwnerConflict) throw unauthorizedChat(request.chatId)
        throw error
      }
      return { chatId: request.chatId, agentId: request.agentId }
    })())
  }

  /**
   * Admit one idempotent message to a chat's ordered Agent inbox.
   * @param request - authenticated owner and identified message.
   * @param signal - optional caller cancellation.
   * @returns admission receipt indicating whether the request already existed.
   */
  async prompt(
    request: ApplicationChatPrompt,
    signal?: AbortSignal,
  ): Promise<{ readonly accepted: true; readonly duplicate: boolean }> {
    this.assertOpen()
    signal?.throwIfAborted()
    const previous = this.admissions.get(request.chatId) ?? Promise.resolve()
    let result: { readonly accepted: true; readonly duplicate: boolean } | undefined
    const operation = previous.then(async () => {
      signal?.throwIfAborted()
      const agent = await this.ownedAgent(request)
      const release = this.agents.pinApplication(agent)
      try {
        const duplicate = hasRequest(agent, request.requestId)
        if (!duplicate) {
          await this.commands.promptApplication(agent, {
            sessionId: request.chatId,
            requestId: brandString<SessionRequestId>(request.requestId),
            mode: 'queue',
            content: request.content,
          })
        }
        await this.sessions.flush(agent.session)
        this.agents.touchApplication(agent)
        result = { accepted: true, duplicate }
      } finally {
        release()
      }
    })
    const tail = operation.then(() => undefined, () => undefined)
    this.admissions.set(request.chatId, tail)
    void tail.then(() => {
      if (this.admissions.get(request.chatId) === tail) this.admissions.delete(request.chatId)
    })
    await this.track(operation)
    return result as { readonly accepted: true; readonly duplicate: boolean }
  }

  /**
   * Cancel current work without dropping queued messages.
   * @param request - authenticated chat address.
   * @param signal - optional caller cancellation.
   * @returns accepted cancellation receipt.
   */
  async cancel(request: ApplicationChatAddress, signal?: AbortSignal): Promise<{ readonly accepted: true }> {
    this.assertOpen()
    signal?.throwIfAborted()
    return this.track((async () => {
      const agent = await this.ownedAgent(request)
      const release = this.agents.pinApplication(agent)
      try {
        signal?.throwIfAborted()
        const result = this.commands.cancelApplication(agent)
        this.agents.touchApplication(agent)
        return result
      } finally {
        release()
      }
    })())
  }

  /**
   * Select the chat's model starting with its next request.
   * @param request - authenticated chat address and model selection.
   * @param signal - optional caller cancellation.
   * @returns the committed selection.
   */
  async selectModel(
    request: ApplicationChatAddress & ModelSelection,
    signal?: AbortSignal,
  ): Promise<{ readonly selected: ModelSelection }> {
    this.assertOpen()
    signal?.throwIfAborted()
    return this.track((async () => {
      const agent = await this.ownedAgent(request)
      const release = this.agents.pinApplication(agent)
      try {
        const result = await this.commands.selectApplicationModel(
          agent,
          {
            sessionId: request.chatId,
            provider: request.provider,
            model: request.model,
            ...(request.reasoningEffort === undefined ? {} : { reasoningEffort: request.reasoningEffort }),
          },
        )
        await this.sessions.flush(agent.session)
        this.agents.touchApplication(agent)
        return result
      } finally {
        release()
      }
    })())
  }

  /**
   * Read one chat's complete durable event log.
   * @param request - authenticated chat address.
   * @param signal - optional cancellation for cold persistence reads.
   * @returns the complete event log after ownership verification.
   */
  async events(request: ApplicationChatAddress, signal?: AbortSignal): Promise<readonly SessionEvent[]> {
    const session = await this.ownedSession(request, signal)
    return session.events
  }

  /**
   * Follow one chat's gap-free Session event stream.
   * @param request - authenticated chat address.
   * @param signal - stream cancellation signal.
   * @returns snapshot-first Session follow frames after ownership verification.
   */
  async *follow(request: ApplicationChatAddress, signal: AbortSignal): AsyncIterable<SessionFollowFrame> {
    using follower = new SessionEventFollower(
      this.ctx,
      request.chatId,
      signal,
      this.closeFollowers,
      nextSeq => new Error(`application chat stream skipped seq ${String(nextSeq)}`),
    )
    const source = await this.ownedSession(request, signal)
    signal.throwIfAborted()
    const cursor = source.events.at(-1)?.seq ?? -1
    follower.snapshotAt(cursor)
    yield {
      type: 'snapshot',
      header: source.header,
      cursor,
      records: source.events.map(eventEntry),
      hasMore: false,
      projections: { asOfSeq: cursor, values: {} },
    }
    for await (const event of follower.eventsAfter(cursor + 1)) {
      yield eventEntry(event)
    }
  }

  private async ownedAgent(request: ApplicationChatAddress, signal?: AbortSignal): Promise<Agent> {
    signal?.throwIfAborted()
    const live = this.sessions.get(request.chatId)
    let found: Awaited<ReturnType<ApiSessionAgentController['resolveAgent']>>
    if (live !== undefined) {
      if (!applicationOwnerEquals(live.header.applicationOwner, request.owner)) {
        throw unauthorizedChat(request.chatId)
      }
      found = await this.agents.resolveApplicationAgent(request.chatId)
    } else {
      using observed = await this.sessionQuery.observeSession(request.chatId, {
        ...(signal === undefined ? {} : { signal }),
        projectionMode: 'none',
      })
      if (!applicationOwnerEquals(observed.header.applicationOwner, request.owner)) {
        throw unauthorizedChat(request.chatId)
      }
      found = await this.agents.resolveObservedApplicationAgent(observed)
    }
    if ('error' in found) throw found.error
    this.agents.touchApplication(found.agent)
    return found.agent
  }

  private track<Value>(operation: Promise<Value>): Promise<Value> {
    this.operations.add(operation)
    void operation.then(
      () => { this.operations.delete(operation) },
      () => { this.operations.delete(operation) },
    )
    return operation
  }

  private assertOpen(): void {
    if (this.closing) throw new Error('application chat controller is closing')
  }

  private async ownedSession(
    request: ApplicationChatAddress,
    signal?: AbortSignal,
  ): Promise<{ readonly header: SessionHeader; readonly events: readonly SessionEvent[] }> {
    const live = this.sessions.get(request.chatId)
    if (live !== undefined) {
      if (!applicationOwnerEquals(live.header.applicationOwner, request.owner)) {
        throw unauthorizedChat(request.chatId)
      }
      return { header: live.header, events: [...live.events] }
    }
    const observed = await this.sessionQuery.observeSession(request.chatId, {
      ...(signal === undefined ? {} : { signal }),
      projectionMode: 'none',
    })
    try {
      if (!applicationOwnerEquals(observed.header.applicationOwner, request.owner)) {
        throw unauthorizedChat(request.chatId)
      }
      return { header: observed.header, events: [...observed.events] }
    } finally {
      observed[Symbol.dispose]()
    }
  }
}

function eventEntry(event: SessionEvent): Extract<SessionFollowFrame, { readonly type: 'event' }> {
  return { type: 'event', event: event as unknown as SessionWireEvent }
}

function hasRequest(agent: Agent, requestId: string): boolean {
  const queued = [...agent.inbox.nextTurn, ...agent.inbox.nextStep]
  if (queued.some(message => message.source.kind === 'user'
    && 'rpcId' in message.source && message.source.rpcId === requestId)) return true
  return agent.session.events.some((event) => {
    if (event.type === 'agent/inbox/spliced') {
      return event.data.inserted.some(message => message.source.kind === 'user'
        && 'rpcId' in message.source && message.source.rpcId === requestId)
    }
    return event.type === 'user/message'
      && event.data.source.kind === 'user'
      && 'rpcId' in event.data.source
      && event.data.source.rpcId === requestId
  })
}

function unauthorizedChat(chatId: SessionId): Error {
  const error = new Error(`chat "${chatId}" is not owned by this application user`)
  Object.assign(error, { code: 'CHAT_FORBIDDEN' })
  return error
}
