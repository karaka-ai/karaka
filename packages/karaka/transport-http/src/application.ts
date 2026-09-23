/** Application operations over unchanged DSH Agents, Sessions and persistence. */
import { Service, type Context } from '@deepseek-ai/cordis'
import { installModelSelection, type Agent, type AgentHandle, type ModelSelection, type ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type { PromptContentPart } from '@deepseek-ai/dsh-attachment'
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type { ApplicationOwner } from '@karaka-ai/identity'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-api-session-controller/types'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { applicationState, installApplicationProjection } from './application-state.ts'

interface Address { readonly chatId: SessionId; readonly owner: ApplicationOwner }
/** Authorized baseline, durable event or transient assistant text emitted by follow(). */
export type FollowFrame = { readonly type: 'snapshot'; readonly header: SessionHeader; readonly hasMore: false; readonly projections: { readonly asOfSeq: number; readonly values: Record<string, never> }; readonly cursor: number; readonly records: readonly { readonly type: 'event'; readonly event: SessionEvent }[] } | { readonly type: 'event'; readonly event: SessionEvent } | { readonly type: 'text-delta'; readonly cursor: number; readonly text: string }

declare module '@deepseek-ai/cordis' {
  interface Context { karakaApplication: ApplicationChatController }
}

/** Owns application activation and serialized durable message admission. */
export class ApplicationChatController extends Service {
  private readonly handles = new Map<SessionId, AgentHandle>()
  private readonly selections = new WeakMap<Agent, ModelSelectionRef>()
  private readonly operations = new Set<Promise<unknown>>()
  private readonly lifetime = new AbortController()

  constructor(ctx: Context) {
    super(ctx, 'karakaApplication')
    installApplicationProjection(ctx)
    ctx.effect(() => async () => {
      this.lifetime.abort(new Error('Application controller disposed'))
      await Promise.allSettled(this.operations)
      await Promise.allSettled([...this.handles.values()].map(handle => handle.dispose()))
      this.handles.clear()
    })
  }

  /**
   * List available, non-broken Agent presets.
   * @param signal - Cancellation checked before listing.
   * @returns Preset identifiers and display metadata; empty when presets are unavailable.
   */
  async listAgents(signal?: AbortSignal) {
    signal?.throwIfAborted()
    const presets = this.ctx.get('agentPresets')
    if (presets === undefined) return []
    const listed = await presets.list()
    return listed.filter(preset => preset.broken === undefined).map(preset => ({
      id: preset.id,
      name: preset.name ?? preset.id,
      ...(preset.description === undefined ? {} : { description: preset.description }),
    }))
  }

  /**
   * Reserve ownership and create or resume a chat, acknowledging only after durable readiness.
   * @param request - Chat identity, trusted owner and requested preset.
   * @param signal - Cancellation checked before mutation begins.
   * @returns Chat and preset identifiers; an incompatible existing preset rejects.
   */
  async create(request: Address & { readonly agentId: string }, signal?: AbortSignal) {
    return this.run(request.chatId, async () => {
      signal?.throwIfAborted()
      const status = await this.ctx.karakaIdentity.reserve(request.chatId, request.owner)
      let agent: Agent
      if (status === 'existing') {
        agent = await this.activate(request)
        if (agent.session.header.agentPreset !== request.agentId) throw Object.assign(new Error('Chat already uses another Agent preset'), { code: 'session/conflict' })
      } else {
        const presets = this.ctx.get('agentPresets')
        if (presets === undefined) throw new Error('Application creation requires Agent presets')
        const preset = await presets.resolve(request.agentId)
        const handle = await this.ctx.agents.create({
          sessionId: request.chatId,
          meta: { agentPreset: preset.id },
          agentOptions: this.ctx.agentDefaultModel.currentSelection(),
          setup: async (agentCtx, unpublished) => {
            await this.ctx.karakaIdentity.bind(unpublished.session, request.owner)
            await presets.mount(agentCtx, preset.id)
            this.installSelection(unpublished)
          },
        })
        this.handles.set(request.chatId, handle)
        agent = handle.agent
      }
      await this.ctx.karakaIdentity.markReady(agent.session, request.owner)
      return { chatId: request.chatId, agentId: request.agentId }
    })
  }

  /**
   * Admit a prompt once per request ID and flush before acknowledgment.
   * @param request - Trusted owner, request ID and text or image prompt content.
   * @param signal - Cancellation checked before mutation begins.
   * @returns Acceptance and duplicate status; unavailable models or invalid attachments reject.
   */
  async prompt(request: Address & { readonly requestId: string; readonly content: readonly PromptContentPart[] }, signal?: AbortSignal) {
    return this.run(request.chatId, async () => {
      signal?.throwIfAborted()
      const agent = await this.activate(request)
      const duplicate = applicationState(this.ctx, agent.session).requestIds.includes(request.requestId)
      if (!duplicate) {
        const selection = this.selections.get(agent)?.current ?? this.ctx.agentDefaultModel.currentSelection()
        if (!this.ctx.llm.listProviders().some(provider => provider.id === selection.provider)) throw Object.assign(new Error('Selected model provider is unavailable'), { code: 'session/model-unavailable' })
        const attachments = this.ctx.get('attachments')
        if (request.content.some(part => part.type === 'image')) {
          if (attachments === undefined) throw Object.assign(new Error('Image attachments are unavailable'), { code: 'session/attachment-invalid' })
          const model = await this.ctx.llm.resolveModelInfo(selection.provider, selection.model)
          if (model.inputModalities !== undefined && !model.inputModalities.includes('image')) throw Object.assign(new Error('Selected model does not accept images'), { code: 'session/attachment-invalid' })
        }
        const content = attachments === undefined
          ? request.content.filter(part => part.type === 'text')
          : await attachments.admitPromptContent(request.content)
        const source = { kind: 'user' as const, rpcId: request.requestId }
        agent.followup(createUserMessage({ content, source }))
      }
      await this.ctx.karakaIdentity.markReady(agent.session, request.owner)
      return { accepted: true as const, duplicate }
    })
  }

  /**
   * Cancel the active turn while retaining pending inbox messages.
   * @param request - Chat identity and trusted owner.
   * @param signal - Cancellation checked before mutation begins.
   * @returns Acknowledgment after the cancellation request is issued.
   */
  async cancel(request: Address, signal?: AbortSignal) {
    return this.run(request.chatId, async () => {
      signal?.throwIfAborted()
      const agent = await this.activate(request)
      agent.cancel({ kind: 'user' }, { keepInbox: true })
      return { accepted: true as const }
    })
  }

  /**
   * Resolve and durably record the chat model selection.
   * @param request - Trusted owner and requested provider, model and reasoning effort.
   * @param signal - Cancellation checked before mutation begins.
   * @returns Resolved model selection after durable readiness.
   */
  async selectModel(
    request: Address & { readonly provider: string; readonly model: string; readonly reasoningEffort?: string },
    signal?: AbortSignal,
  ) {
    return this.run(request.chatId, async () => {
      signal?.throwIfAborted()
      const agent = await this.activate(request)
      const resolved = await this.ctx.llm.resolveCallConfig({
        provider: request.provider,
        model: request.model,
        ...(request.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(request.reasoningEffort) }),
      })
      const selected: ModelSelection = {
        provider: resolved.provider,
        model: resolved.model,
        ...(resolved.reasoningEffort === undefined ? {} : { reasoningEffort: resolved.reasoningEffort }),
      }
      agent.session.append('model/selection', selected)
      const selection = this.selections.get(agent)
      if (selection === undefined) throw new Error('Application Agent has no model selection')
      selection.current = selected
      await this.ctx.karakaIdentity.markReady(agent.session, request.owner)
      return { selected }
    })
  }

  /**
   * Read durable chat events after authorizing the requested owner.
   * @param request - Chat identity and trusted owner.
   * @param signal - Cancellation propagated to the Session observation.
   * @returns Detached event list; unauthorized owners reject.
   */
  async events(request: Address, signal?: AbortSignal): Promise<readonly SessionEvent[]> {
    signal?.throwIfAborted()
    await this.ctx.karakaIdentity.authorize(request.chatId, request.owner)
    using observed = await this.ctx.sessionQuery.observeSession(request.chatId, { projectionMode: 'none', ...(signal === undefined ? {} : { signal }) })
    return [...observed.events]
  }

  /**
   * Subscribe before reading the baseline, then deliver each subsequent sequence once.
   * @param request - Chat identity and trusted owner, reauthorized before each live delivery.
   * @param supplied - Cancellation combined with controller disposal.
   * @returns Snapshot-first stream of durable events and transient text deltas; sequence gaps reject.
   */
  async *follow(request: Address, supplied: AbortSignal): AsyncIterable<FollowFrame> {
    const signal = AbortSignal.any([supplied, this.lifetime.signal])
    let wake = Promise.withResolvers<void>()
    const queued: ({ readonly type: 'event'; readonly event: SessionEvent } | { readonly type: 'text-delta'; readonly cursor: number; readonly text: string })[] = []
    const stop = this.ctx.on('session/event', (session, event) => {
      if (session.id !== request.chatId) return
      queued.push({ type: 'event', event })
      wake.resolve()
    }, { global: true })
    const stopStream = this.ctx.on('agent/assistant-stream', ({ agent, frame }) => {
      if (agent.id !== request.chatId || frame.type !== 'chunk' || frame.chunk.type !== 'text-delta') return
      queued.push({ type: 'text-delta', cursor: agent.session.seq - 1, text: frame.chunk.text })
      wake.resolve()
    }, { global: true })
    const abort = (): void => { wake.resolve() }
    signal.addEventListener('abort', abort, { once: true })
    try {
      signal.throwIfAborted()
      const header = await this.ctx.karakaIdentity.authorize(request.chatId, request.owner)
      const events = await this.events(request, signal)
      let cursor = events.at(-1)?.seq ?? -1
      yield { type: 'snapshot', header, hasMore: false, projections: { asOfSeq: cursor, values: {} }, cursor, records: events.map(event => ({ type: 'event' as const, event })) }
      while (!signal.aborted) {
        const next = queued.shift()
        if (next === undefined) {
          await wake.promise
          wake = Promise.withResolvers<void>()
          continue
        }
        if (next.type === 'text-delta') {
          if (next.cursor < cursor) continue
          await this.ctx.karakaIdentity.authorize(request.chatId, request.owner)
          yield next
          continue
        }
        if (next.event.seq <= cursor) continue
        if (next.event.seq !== cursor + 1) throw new Error('Application event stream lost sequence continuity')
        await this.ctx.karakaIdentity.authorize(request.chatId, request.owner)
        cursor = next.event.seq
        yield next
      }
    } finally {
      stop()
      stopStream()
      signal.removeEventListener('abort', abort)
    }
  }

  private async activate(request: Address): Promise<Agent> {
    const header = await this.ctx.karakaIdentity.authorize(request.chatId, request.owner)
    const live = this.ctx.agents.get(request.chatId)
    if (live !== undefined) {
      await this.ctx.karakaIdentity.authorizeSession(live.session, request.owner)
      if (!this.handles.has(request.chatId)) throw Object.assign(new Error('Agent is owned by another controller'), { code: 'session/conflict' })
      return live
    }
    const presets = this.ctx.get('agentPresets')
    if (presets === undefined || header.agentPreset === undefined) throw new Error('Application Session has no resolvable Agent preset')
    const handle = await this.ctx.agents.resume({
      resumeSessionId: request.chatId,
      agentOptions: this.ctx.agentDefaultModel.currentSelection(),
      setup: async (agentCtx, agent) => {
        await this.ctx.karakaIdentity.authorizeSession(agent.session, request.owner)
        await presets.mount(agentCtx, header.agentPreset)
        this.installSelection(agent)
      },
    })
    this.handles.set(request.chatId, handle)
    return handle.agent
  }

  private installSelection(agent: Agent): void {
    const state = applicationState(this.ctx, agent.session)
    const selection: ModelSelectionRef = {
      current: state.pending ?? state.lastUsed ?? this.ctx.agentDefaultModel.currentSelection(),
      assembled: undefined,
    }
    agent.ctx.effect(() => installModelSelection(agent.ctx, selection))
    this.selections.set(agent, selection)
  }

  private run<Value>(id: SessionId, operation: () => Promise<Value>): Promise<Value> {
    this.lifetime.signal.throwIfAborted()
    const pending = this.ctx.karakaIdentity.withChatLock(id, operation)
    this.operations.add(pending)
    void pending.then(() => this.operations.delete(pending), () => this.operations.delete(pending))
    return pending
  }
}
