/** Durable application request receipts and model selection, maintained by Session projections. */
import type { Context } from '@deepseek-ai/cordis'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-api-session-controller/types'
import { z } from 'zod'

/** Host-only state reconstructed from durable inbox, user-message and model events. */
export interface ApplicationState {
  /** Every admitted application request ID, including messages still in the inbox. */
  readonly requestIds: readonly string[]
  /** Last model route used by a request, excluding adapter-default reasoning effort. */
  readonly lastUsed: ModelSelection | null
  /** Explicit user selection not yet consumed by a matching model request. */
  readonly pending: ModelSelection | null
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Durable application admission and model-selection state. */
    karakaApplication: ApplicationState
  }
}

const modelSelectionSchema = z.object({
  provider: z.string(),
  model: z.string(),
  reasoningEffort: z.string().optional(),
}).transform(({ reasoningEffort, ...route }): ModelSelection => ({
  ...route,
  ...(reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(reasoningEffort) }),
}))

const applicationProjection: ProjectionDefinition<'karakaApplication', ApplicationState> = {
  key: 'karakaApplication',
  stateVersion: 1,
  stateSchema: z.object({
    requestIds: z.array(z.string()),
    lastUsed: modelSelectionSchema.nullable(),
    pending: modelSelectionSchema.nullable(),
  }),
  init: () => ({ requestIds: [], lastUsed: null, pending: null }),
  apply: foldApplicationState,
}

function foldApplicationState(state: ApplicationState, event: SessionEvent): ApplicationState {
  if (event.type === 'model/selection') {
    const { provider, model, reasoningEffort } = event.data
    return { ...state, pending: {
      provider, model,
      ...(reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(reasoningEffort) }),
    } }
  }
  if (event.type === 'request/header') {
    const { provider, model, reasoningEffort } = event.data.header.config
    const consumed = state.pending?.provider === provider && state.pending.model === model
      && state.pending.reasoningEffort === reasoningEffort
    return {
      ...state,
      lastUsed: {
        provider, model,
        ...(reasoningEffort === undefined || event.data.header.adapterDefaults?.reasoningEffort === true ? {} : { reasoningEffort }),
      },
      pending: consumed ? null : state.pending,
    }
  }
  const messages = event.type === 'agent/inbox/spliced' ? event.data.inserted : event.type === 'user/message' ? [event.data] : []
  const ids = messages.flatMap(({ source }) => source.kind === 'user' && 'rpcId' in source ? [source.rpcId] : [])
  const added = ids.filter((id, index) => !state.requestIds.includes(id) && ids.indexOf(id) === index)
  return added.length === 0 ? state : { ...state, requestIds: [...state.requestIds, ...added] }
}

/**
 * Register application state under the calling plugin's lifecycle.
 * @param ctx - Context with the Session projection registry.
 */
export function installApplicationProjection(ctx: Context): void {
  ctx.sessionProjections.register(applicationProjection)
}

/**
 * Read application state without scanning arbitrary Session event positions.
 * @param ctx - Context with the registered application projection.
 * @param session - Live or reconstructed Session to project.
 * @returns Current admission and model-selection state; a missing projection throws.
 */
export function applicationState(ctx: Context, session: Session): ApplicationState {
  const state = ctx.sessionProjections.stateOf(session, 'karakaApplication')
  if (state === undefined) throw new Error('Application Session projection is not registered')
  return state
}
