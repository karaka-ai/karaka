/** Agent activation, composition, and model-selection policy owned by API Session. */

import { mkdir } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type {
  Agent, AgentHandle, AgentOptions, AgentSetup, ModelSelection as AgentModelSelection, ModelSelectionRef,
} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-agent-presets'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { ApplicationOwner, Session, SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { SessionQueryError, type SessionObservation } from '@deepseek-ai/dsh-session-query'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-typert-registry'
import type { ModelSelection } from './types.ts'

/** Cold Session identity absent from persistence. */
export class ApiSessionNotFound extends Error {}

/** Session identity whose lifecycle belongs to subagent routing. */
export class ApiSessionSubagentOwnership extends Error {
  /** @param sessionId - identity reserved to subagent routing. */
  constructor(readonly sessionId: SessionId) {
    super(`session "${sessionId}" is a subagent session; use subagent delivery`)
  }
}

/** Explicit-id creation attempted to adopt a Session under another cwd. */
export class ApiSessionCwdConflict extends Error {
  constructor(
    readonly sessionId: SessionId,
    readonly requestedCwd: string,
    readonly existingCwd: string | undefined,
  ) {
    super(
      existingCwd === undefined
        ? `session "${sessionId}" records no cwd and cannot be adopted for "${requestedCwd}"`
        : `session "${sessionId}" belongs to "${existingCwd}", not "${requestedCwd}"`,
    )
  }
}

/** Explicit-id creation attempted to adopt a Session under another preset. */
export class ApiSessionPresetConflict extends Error {
  constructor(
    readonly sessionId: SessionId,
    readonly requestedPreset: string,
    readonly existingPreset: string | undefined,
  ) {
    super(
      existingPreset === undefined
        ? `session "${sessionId}" records no agent preset and cannot be adopted under "${requestedPreset}"`
        : `session "${sessionId}" runs agent preset "${existingPreset}", not "${requestedPreset}"`,
    )
  }
}

/** Explicit-id operation attempted to use a Session owned by another application user. */
export class ApiSessionApplicationOwnerConflict extends Error {
  constructor(readonly sessionId: SessionId) {
    super(`session "${sessionId}" belongs to another application user`)
  }
}

/** Session identity whose lifecycle belongs to authenticated application routing. */
export class ApiSessionApplicationOwnership extends Error {
  /** @param sessionId - identity reserved to the application chat API. */
  constructor(readonly sessionId: SessionId) {
    super(`session "${sessionId}" is an application chat; use authenticated application routing`)
  }
}

/**
 * Compare a Session owner with an authenticated application user.
 * @param actual - owner recorded on the Session, when any.
 * @param expected - authenticated owner required by the operation.
 * @returns whether all three owner fields match exactly.
 */
export function applicationOwnerEquals(
  actual: ApplicationOwner | undefined,
  expected: ApplicationOwner,
): boolean {
  return actual?.applicationId === expected.applicationId
    && actual.tenantId === expected.tenantId
    && actual.userId === expected.userId
}

/** Failures produced while resolving one ordinary Session identity to its live Agent. */
export type ApiSessionAgentError = RemoteError<'session/not-found' | 'session/agent-busy' | 'gateway/internal'>

/** Result of resolving one ordinary Session identity to its live Agent. */
export type ApiSessionAgentResult =
  | { readonly agent: Agent }
  | { readonly error: ApiSessionAgentError }

type InstalledSelection = ModelSelectionRef & {
  current: AgentModelSelection
  consume(provider: string, model: string, reasoningEffort: string | undefined): boolean
}

type ApplicationHandleEntry = {
  readonly handle: AgentHandle
  activeOperations: number
  generation: number
  timer: NodeJS.Timeout | undefined
}

/**
 * Test whether generic Session routing must leave an identity to subagent routing.
 * @param ctx - Host context carrying the Agent ownership registry.
 * @param session - attached or live Session whose ownership is tested.
 * @param agent - live Agent when one exists for the Session.
 * @returns whether subagent routing owns the Session identity.
 */
export function hasApiSessionSubagentOwner(
  ctx: Context,
  session: Pick<Session, 'header'>,
  agent: Agent | undefined,
): boolean {
  if (session.header.origin === 'subagent') return true
  const parentId = session.header.parentSession
  if (parentId === undefined || agent === undefined) return false
  const parent = ctx.agents.get(parentId)
  return parent !== undefined && ctx.agents.isOwnedBy(agent.id, parent)
}

/**
 * Build the stable caller-facing subagent ownership rejection.
 * @param sessionId - Session identity owned by subagent routing.
 * @returns a stable Session-domain failure.
 */
export function apiSessionSubagentOwnershipError(sessionId: SessionId): ApiSessionAgentError {
  return new RemoteError(
    'session/agent-busy',
    `session "${sessionId}" is owned by subagent routing`,
    { reason: 'use subagent delivery for this child session' },
  )
}

/**
 * Build the stable rejection used when generic DSH routing reaches an application chat.
 * @param sessionId - Session identity owned by authenticated application routing.
 * @returns a stable Session-domain failure.
 */
export function apiSessionApplicationOwnershipError(sessionId: SessionId): ApiSessionAgentError {
  return new RemoteError(
    'session/agent-busy',
    `session "${sessionId}" is owned by authenticated application routing`,
    { reason: 'use the application chat API for this session' },
  )
}

/**
 * Inspect one cold Session without repairing, resuming, or publishing it.
 * @param ctx - Host context carrying Session persistence.
 * @param sessionId - durable Session identity.
 * @param signal - optional cancellation for persistence reads.
 * @returns the persisted header and complete event prefix.
 */
export async function inspectApiSession(
  ctx: Context,
  sessionId: SessionId,
  signal?: AbortSignal,
): Promise<{ meta: SessionHeader; events: SessionEvent[] }> {
  try {
    using observation = await ctx.sessionQuery.observeSession(sessionId, {
      ...(signal === undefined ? {} : { signal }),
      projectionMode: 'none',
    })
    if (observation.header.cwd === undefined) {
      throw new ApiSessionNotFound(`session "${sessionId}" not found`)
    }
    if (observation.header.applicationOwner !== undefined) {
      throw new ApiSessionApplicationOwnership(sessionId)
    }
    return { meta: observation.header, events: [...observation.events] }
  } catch (error: unknown) {
    if (error instanceof SessionQueryError
      && error.code === 'SESSION_QUERY_SESSION_NOT_FOUND') {
      throw new ApiSessionNotFound(`session "${sessionId}" not found`)
    }
    throw error
  }
}

/** Owns every operation that may create, resume, or configure a Web Agent. */
export class ApiSessionAgentController {
  private readonly resumes = new Map<SessionId, Promise<Agent>>()
  private readonly creations = new Map<SessionId, Promise<Agent>>()
  private readonly selections = new WeakMap<Agent, InstalledSelection>()
  private readonly imageAdmissionChains = new WeakMap<Agent, Promise<void>>()
  private readonly applicationHandles = new Map<SessionId, ApplicationHandleEntry>()
  private readonly applicationEvictions = new Map<SessionId, Promise<void>>()
  private closing = false

  /**
   * @param ctx - Host context carrying Agent, model, persistence, and Typert services.
   * @param applicationIdleMs - idle residency before an application Agent is disposed and left durable.
   */
  constructor(private readonly ctx: Context, private readonly applicationIdleMs = 300_000) {
    if (!Number.isFinite(applicationIdleMs) || applicationIdleMs < 1) {
      throw new Error('session-controller: applicationIdleMs must be a positive finite number')
    }
    ctx.effect(() => async () => {
      this.closing = true
      for (const entry of this.applicationHandles.values()) {
        if (entry.timer !== undefined) clearTimeout(entry.timer)
      }
      await Promise.allSettled(this.applicationEvictions.values())
      const handles = [...this.applicationHandles.values()]
      this.applicationHandles.clear()
      await Promise.allSettled(handles.map(entry => entry.handle.dispose()))
    }, 'session-controller.application-agents')
    ctx.on('agent/status', ({ agent, status }) => {
      const entry = this.applicationHandles.get(agent.id)
      if (entry === undefined || entry.handle.agent !== agent) return
      this.cancelApplicationEviction(entry)
      if (status === 'idle' && entry.activeOperations === 0) {
        this.armApplicationEviction(agent, entry, entry.generation)
      }
    }, { global: true })
    ctx.typert.lookups.configure('agent', async (sessionId: SessionId) => {
      const found = await this.resolveAgent(sessionId)
      if ('error' in found) throw found.error
      return found.agent
    })
    ctx.typert.lookups.configure('session', async (sessionId: SessionId) => {
      const found = await this.resolveAgent(sessionId)
      if ('error' in found) throw found.error
      return found.agent.session
    })
    ctx.typert.contexts.configureHost('agent', async (sessionId: SessionId) => {
      const found = await this.resolveAgent(sessionId)
      if ('error' in found) throw found.error
      return found.agent.ctx
    })
  }

  /**
   * Resolve or resume one ordinary Session, deduplicating concurrent resumes.
   * @param sessionId - ordinary Session identity.
   * @returns the live Agent or a stable Session-domain failure.
   */
  async resolveAgent(sessionId: SessionId): Promise<ApiSessionAgentResult> {
    return this.resolve(sessionId, undefined, false)
  }

  /**
   * Resolve one ordinary Session from an already-retained exact observation.
   * @param observation - Host-owned observation whose preparation stays pinned through setup.
   * @returns the live Agent or a stable Session-domain failure.
   */
  async resolveObservedAgent(observation: SessionObservation): Promise<ApiSessionAgentResult> {
    return this.resolve(observation.header.id, observation, false)
  }

  /**
   * Resolve an application chat after its authenticated owner was verified.
   * @param sessionId - application chat identity.
   * @returns the live Agent or a stable Session-domain failure.
   */
  async resolveApplicationAgent(sessionId: SessionId): Promise<ApiSessionAgentResult> {
    return this.resolve(sessionId, undefined, true)
  }

  /**
   * Resolve an application chat from an owner-verified retained observation.
   * @param observation - exact retained observation carrying application ownership.
   * @returns the live Agent or a stable Session-domain failure.
   */
  async resolveObservedApplicationAgent(observation: SessionObservation): Promise<ApiSessionAgentResult> {
    return this.resolve(observation.header.id, observation, true)
  }

  private async resolve(
    sessionId: SessionId,
    observation?: SessionObservation,
    allowApplication = false,
  ): Promise<ApiSessionAgentResult> {
    await this.applicationEvictions.get(sessionId)
    const live = this.liveAgent(sessionId, allowApplication)
    if (live !== undefined) return live
    const attached = this.ctx.sessions.get(sessionId)
    if (attached !== undefined && hasApiSessionSubagentOwner(this.ctx, attached, undefined)) {
      return { error: apiSessionSubagentOwnershipError(sessionId) }
    }

    let resume = this.resumes.get(sessionId)
    if (resume === undefined) {
      resume = this.resume(sessionId, observation, allowApplication).finally(() => { this.resumes.delete(sessionId) })
      this.resumes.set(sessionId, resume)
    }
    try {
      const agent = await resume
      if (!allowApplication && agent.session.header.applicationOwner !== undefined) {
        return { error: apiSessionApplicationOwnershipError(sessionId) }
      }
      return { agent }
    } catch (error: unknown) {
      if (error instanceof ApiSessionNotFound) {
        return { error: new RemoteError('session/not-found', error.message, { sessionId }) }
      }
      if (error instanceof ApiSessionSubagentOwnership) {
        return { error: apiSessionSubagentOwnershipError(error.sessionId) }
      }
      if (error instanceof ApiSessionApplicationOwnership) {
        return { error: apiSessionApplicationOwnershipError(error.sessionId) }
      }
      const raced = this.liveAgent(sessionId, allowApplication)
      if (raced !== undefined) return raced
      const racedSession = this.ctx.sessions.get(sessionId)
      if (racedSession !== undefined && hasApiSessionSubagentOwner(this.ctx, racedSession, undefined)) {
        return { error: apiSessionSubagentOwnershipError(sessionId) }
      }
      return {
        error: new RemoteError(
          'gateway/internal',
          `resume failed for session "${sessionId}": ${String(error)}`,
          {},
        ),
      }
    }
  }

  /**
   * Resolve one requested identity, creating or resuming it once.
   * @param sessionId - requested Session identity.
   * @param cwd - directory the Session must own.
   * @param checkPersistedIdentity - whether to inspect a cold identity before creation.
   * @param presetId - optional Agent preset the Session must own.
   * @param applicationOwner - optional authenticated application owner the Session must match.
   * @returns the matching live ordinary Agent.
   */
  async ensureSession(
    sessionId: SessionId,
    cwd: string | undefined,
    checkPersistedIdentity: boolean,
    presetId?: string,
    applicationOwner?: ApplicationOwner,
  ): Promise<Agent> {
    await this.applicationEvictions.get(sessionId)
    let creation = this.creations.get(sessionId)
    if (creation === undefined) {
      creation = this.createOrAdopt(sessionId, cwd, checkPersistedIdentity, presetId, applicationOwner)
        .catch((error: unknown) => {
          const live = this.ctx.agents.get(sessionId)
          if (live !== undefined) {
            if (hasApiSessionSubagentOwner(this.ctx, live.session, live)) {
              throw new ApiSessionSubagentOwnership(sessionId)
            }
            return live
          }
          const attached = this.ctx.sessions.get(sessionId)
          if (attached !== undefined && hasApiSessionSubagentOwner(this.ctx, attached, undefined)) {
            throw new ApiSessionSubagentOwnership(sessionId)
          }
          throw error
        })
        .finally(() => { this.creations.delete(sessionId) })
      this.creations.set(sessionId, creation)
    }
    const agent = await creation
    if (hasApiSessionSubagentOwner(this.ctx, agent.session, agent)) {
      throw new ApiSessionSubagentOwnership(sessionId)
    }
    if (presetId !== undefined) {
      this.assertPresetUnchanged(sessionId, presetId, this.presetForSession(agent.session))
    }
    if (applicationOwner !== undefined
      && !applicationOwnerEquals(agent.session.header.applicationOwner, applicationOwner)) {
      throw new ApiSessionApplicationOwnerConflict(sessionId)
    }
    if (applicationOwner === undefined && agent.session.header.applicationOwner !== undefined) {
      throw new ApiSessionApplicationOwnership(sessionId)
    }
    if (agent.session.header.cwd !== cwd) {
      if (cwd === undefined) throw new Error(`session "${sessionId}" is not a workspace-free application chat`)
      throw new ApiSessionCwdConflict(sessionId, cwd, agent.session.header.cwd)
    }
    return agent
  }

  /**
   * Reset idle eviction after an authenticated application operation.
   * @param agent - retained application Agent that was used.
   */
  touchApplication(agent: Agent): void {
    if (this.closing) return
    const entry = this.applicationHandles.get(agent.id)
    if (entry === undefined || entry.handle.agent !== agent) return
    this.cancelApplicationEviction(entry)
    if (entry.activeOperations > 0) return
    const generation = entry.generation
    if (agent.status === 'idle') {
      this.armApplicationEviction(agent, entry, generation)
      return
    }
    void agent.whenIdle().then(() => {
      this.armApplicationEviction(agent, entry, generation)
    })
  }

  /**
   * Keep one retained application Agent live for an authenticated operation.
   * @param agent - owner-verified application Agent used by the operation.
   * @returns idempotent release that restarts idle eviction after the operation settles.
   */
  pinApplication(agent: Agent): () => void {
    const entry = this.applicationHandles.get(agent.id)
    if (entry === undefined || entry.handle.agent !== agent) {
      throw new Error(`session-controller: application Agent "${agent.id}" has no retained handle`)
    }
    this.cancelApplicationEviction(entry)
    entry.activeOperations += 1
    let active = true
    return () => {
      if (!active) return
      active = false
      if (this.applicationHandles.get(agent.id) !== entry) return
      entry.activeOperations -= 1
      if (entry.activeOperations === 0) this.touchApplication(agent)
    }
  }

  /**
   * Install or return the Session-local model selection used by prompt assembly.
   * @param agent - live Agent that owns the selection.
   * @returns the installed mutable selection reference.
   */
  selectionFor(agent: Agent): InstalledSelection {
    const installed = this.selections.get(agent)
    if (installed !== undefined) return installed
    const projectionState = this.ctx.sessionProjections.stateOf(agent.session, 'modelSelection')
    if (projectionState === undefined) {
      throw new Error('api-session: required modelSelection projection is not registered')
    }
    let picked = projectionState.pending === null
      ? undefined
      : agentModelSelection(projectionState.pending)
    const defaultModel = this.ctx.agentDefaultModel
    const selection: InstalledSelection = {
      get current(): AgentModelSelection {
        if (picked !== undefined) return picked
        const loggedHeader = agent.session.requestHeader()
        if (loggedHeader === undefined) return defaultModel.currentSelection()
        const logged = loggedHeader.config
        return {
          provider: logged.provider,
          model: logged.model,
          // An effort the adapter defaulted is not a conversation choice: restoring
          // it as one would make an unchanged default read as a request change.
          ...(logged.reasoningEffort === undefined
            || loggedHeader.adapterDefaults?.reasoningEffort === true
            ? {}
            : { reasoningEffort: logged.reasoningEffort }),
        }
      },
      set current(next: AgentModelSelection) {
        picked = next
      },
      consume(provider: string, model: string, reasoningEffort: string | undefined): boolean {
        if (picked?.provider !== provider
          || picked.model !== model
          || picked.reasoningEffort !== reasoningEffort) return false
        picked = undefined
        return true
      },
      assembled: undefined,
    }
    installModelSelection(agent.ctx, selection)
    this.selections.set(agent, selection)
    return selection
  }

  /**
   * Commit and cache one validated selection for the next prompt assembly.
   * @param agent - live Agent that owns the selection.
   * @param selection - validated selection to record and apply.
   */
  selectForNextRequest(agent: Agent, selection: AgentModelSelection): void {
    agent.session.append('model/selection', selection)
    this.selectionFor(agent).current = selection
  }

  /**
   * Let a matching durable request header retire the execution cache.
   * @param agent - live Agent whose request was recorded.
   * @param provider - provider route used by the request.
   * @param model - provider-owned model used by the request.
   * @param reasoningEffort - adapter-owned effort used by the request.
   * @returns whether the pending selection was consumed.
   */
  consumeSelection(
    agent: Agent,
    provider: string,
    model: string,
    reasoningEffort: string | undefined,
  ): boolean {
    return this.selections.get(agent)?.consume(provider, model, reasoningEffort) ?? false
  }

  /**
   * Read the current Agent preset from the Session projection.
   * @param session - live Session whose projection state is available.
   * @returns the current preset, or undefined when the capability is absent.
   */
  presetForSession(session: Session): string | undefined {
    return this.ctx.sessionProjections.stateOf(session, 'agentPreset') ?? undefined
  }

  /**
   * Serialize image admission and model selection for one Agent.
   * @param agent - live Agent that owns the serialization chain.
   * @param operation - asynchronous operation admitted after prior work settles.
   * @returns the operation result or rejection.
   */
  serializeImageAdmission<Value>(agent: Agent, operation: () => Promise<Value>): Promise<Value> {
    const result = (this.imageAdmissionChains.get(agent) ?? Promise.resolve()).then(operation)
    this.imageAdmissionChains.set(agent, result.then(() => undefined, () => undefined))
    return result
  }

  /**
   * Resolve the preset id and pre-publication Agent setup for a create or resume.
   * @param presetId - requested preset or the configured default when omitted.
   * @returns the resolved preset identity and Agent setup callback.
   */
  async composeAgent(presetId: string | undefined): Promise<{
    readonly agentPreset?: string
    readonly setup: AgentSetup
  }> {
    const presets = this.ctx.get('agentPresets')
    if (presets === undefined) return { setup: (agentCtx) => { this.installSelection(agentCtx) } }
    const resolvedId = (await presets.resolve(presetId)).id
    return {
      agentPreset: resolvedId,
      setup: async (agentCtx) => {
        this.installSelection(agentCtx)
        await presets.mount(agentCtx, resolvedId)
      },
    }
  }

  private liveAgent(sessionId: SessionId, allowApplication: boolean): ApiSessionAgentResult | undefined {
    const agent = this.ctx.agents.get(sessionId)
    if (agent === undefined) return undefined
    if (!allowApplication && agent.session.header.applicationOwner !== undefined) {
      return { error: apiSessionApplicationOwnershipError(sessionId) }
    }
    return hasApiSessionSubagentOwner(this.ctx, agent.session, agent)
      ? { error: apiSessionSubagentOwnershipError(sessionId) }
      : { agent }
  }

  private async resume(
    sessionId: SessionId,
    supplied: SessionObservation | undefined,
    allowApplication: boolean,
  ): Promise<Agent> {
    if (supplied !== undefined) return this.resumeObserved(sessionId, supplied, allowApplication)
    try {
      using observation = await this.ctx.sessionQuery.observeSession(sessionId)
      return await this.resumeObserved(sessionId, observation, allowApplication)
    } catch (error: unknown) {
      if (error instanceof SessionQueryError
        && error.code === 'SESSION_QUERY_SESSION_NOT_FOUND') {
        throw new ApiSessionNotFound(`session "${sessionId}" not found`)
      }
      throw error
    }
  }

  private async resumeObserved(
    sessionId: SessionId,
    observation: SessionObservation,
    allowApplication: boolean,
  ): Promise<Agent> {
    if (observation.header.id !== sessionId
      || (observation.header.cwd === undefined && observation.header.applicationOwner === undefined)) {
      throw new ApiSessionNotFound(`session "${sessionId}" not found`)
    }
    if (hasApiSessionSubagentOwner(this.ctx, { header: observation.header }, undefined)) {
      throw new ApiSessionSubagentOwnership(sessionId)
    }
    if (!allowApplication && observation.header.applicationOwner !== undefined) {
      throw new ApiSessionApplicationOwnership(sessionId)
    }
    const composition = await this.composeAgent(this.presetForObservation(observation))
    const published = this.ctx.sessions.get(sessionId)
    const live = this.ctx.agents.get(sessionId)
    if (published !== undefined && hasApiSessionSubagentOwner(this.ctx, published, live)) {
      throw new ApiSessionSubagentOwnership(sessionId)
    }
    const handle = await this.ctx.agents.resume({
      resumeSessionId: sessionId,
      agentOptions: this.agentOptions(),
      setup: composition.setup,
    })
    this.retainApplicationHandle(handle)
    return handle.agent
  }

  private async createOrAdopt(
    sessionId: SessionId,
    cwd: string | undefined,
    checkPersistedIdentity: boolean,
    presetId: string | undefined,
    applicationOwner: ApplicationOwner | undefined,
  ): Promise<Agent> {
    const attached = this.ctx.sessions.get(sessionId)
    const live = this.ctx.agents.get(sessionId)
    if (attached !== undefined && hasApiSessionSubagentOwner(this.ctx, attached, live)) {
      throw new ApiSessionSubagentOwnership(sessionId)
    }
    if (live !== undefined) return live

    if (checkPersistedIdentity) {
      try {
        using observation = await this.ctx.sessionQuery.observeSession(sessionId)
        if (hasApiSessionSubagentOwner(this.ctx, { header: observation.header }, undefined)) {
          throw new ApiSessionSubagentOwnership(sessionId)
        }
        if (applicationOwner !== undefined
          && !applicationOwnerEquals(observation.header.applicationOwner, applicationOwner)) {
          throw new ApiSessionApplicationOwnerConflict(sessionId)
        }
        if (observation.header.cwd !== cwd) {
          if (cwd === undefined) throw new Error(`session "${sessionId}" is not a workspace-free application chat`)
          throw new ApiSessionCwdConflict(sessionId, cwd, observation.header.cwd)
        }
        const storedPreset = this.presetForObservation(observation)
        this.assertPresetUnchanged(sessionId, presetId, storedPreset)
        const composition = await this.composeAgent(storedPreset)
        const handle = await this.ctx.agents.resume({
          resumeSessionId: sessionId,
          agentOptions: this.agentOptions(),
          setup: composition.setup,
        })
        this.retainApplicationHandle(handle)
        return handle.agent
      } catch (error: unknown) {
        if (!(error instanceof SessionQueryError)
          || error.code !== 'SESSION_QUERY_SESSION_NOT_FOUND') throw error
      }
    }

    if (cwd !== undefined) {
      try {
        await mkdir(cwd, { recursive: true })
      } catch (error: unknown) {
        throw new Error(`failed to ensure project directory "${cwd}": ${String(error)}`, { cause: error })
      }
    }
    const composition = await this.composeAgent(presetId)
    const handle = await this.ctx.agents.create({
      sessionId,
      agentOptions: this.agentOptions(),
      meta: {
        ...(cwd === undefined ? {} : { cwd }),
        ...(applicationOwner === undefined ? {} : { applicationOwner }),
        ...(composition.agentPreset === undefined ? {} : { agentPreset: composition.agentPreset }),
      },
      setup: composition.setup,
    })
    this.retainApplicationHandle(handle)
    return handle.agent
  }

  private retainApplicationHandle(handle: AgentHandle): void {
    if (handle.agent.session.header.applicationOwner === undefined) return
    const existing = this.applicationHandles.get(handle.agent.id)
    if (existing !== undefined && existing.handle !== handle) {
      throw new Error(`session-controller: application Agent "${handle.agent.id}" already has a retained handle`)
    }
    if (existing === undefined) {
      this.applicationHandles.set(handle.agent.id, {
        handle,
        activeOperations: 0,
        generation: 0,
        timer: undefined,
      })
    }
    this.touchApplication(handle.agent)
  }

  private cancelApplicationEviction(
    entry: ApplicationHandleEntry,
  ): void {
    entry.generation += 1
    if (entry.timer === undefined) return
    clearTimeout(entry.timer)
    entry.timer = undefined
  }

  private armApplicationEviction(
    agent: Agent,
    entry: ApplicationHandleEntry,
    generation: number,
  ): void {
    if (this.closing
      || this.applicationHandles.get(agent.id) !== entry
      || entry.generation !== generation
      || entry.activeOperations > 0
      || agent.status !== 'idle') return
    entry.timer = setTimeout(
      () => { this.beginApplicationEviction(agent.id, entry, generation) },
      this.applicationIdleMs,
    )
    entry.timer.unref()
  }

  private beginApplicationEviction(
    sessionId: SessionId,
    entry: ApplicationHandleEntry,
    generation: number,
  ): void {
    if (this.applicationHandles.get(sessionId) !== entry
      || entry.generation !== generation
      || entry.activeOperations > 0
      || entry.handle.agent.status !== 'idle') return
    entry.timer = undefined
    const eviction = entry.handle.dispose().then(
      () => {
        if (this.applicationHandles.get(sessionId) === entry) this.applicationHandles.delete(sessionId)
      },
      (error: unknown) => {
        this.ctx.logger.error(
          `session-controller: idle application Agent "${sessionId}" disposal failed: ${String(error)}`,
        )
        if (this.closing || this.ctx.agents.get(sessionId) !== entry.handle.agent) {
          if (this.applicationHandles.get(sessionId) === entry) this.applicationHandles.delete(sessionId)
          return
        }
        this.touchApplication(entry.handle.agent)
      },
    )
      .finally(() => { this.applicationEvictions.delete(sessionId) })
    this.applicationEvictions.set(sessionId, eviction)
  }

  private agentOptions(): AgentOptions {
    const { provider, model } = this.ctx.agentDefaultModel.currentSelection()
    return { provider, model }
  }

  private installSelection(agentCtx: Context): void {
    const agent = agentCtx.agent
    if (agent === undefined) throw new Error('api-session: Agent setup has no scoped Agent')
    this.selectionFor(agent)
  }

  /**
   * Read the current Agent preset from an all-projections observation.
   * @param observation - exact Session observation carrying its projection snapshot.
   * @returns the current preset, or undefined when the capability is absent.
   */
  presetForObservation(observation: SessionObservation): string | undefined {
    if (observation.projections === undefined) {
      throw new Error('api-session: Agent activation requires a projected Session observation')
    }
    return observation.projections.values.agentPreset ?? undefined
  }

  private assertPresetUnchanged(
    sessionId: SessionId,
    requested: string | undefined,
    existing: string | undefined,
  ): void {
    if (requested === undefined || requested === existing) return
    throw new ApiSessionPresetConflict(sessionId, requested, existing)
  }
}

function agentModelSelection(selection: ModelSelection): AgentModelSelection {
  return {
    provider: selection.provider,
    model: selection.model,
    ...(selection.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: ReasoningEffortId(selection.reasoningEffort) }),
  }
}
