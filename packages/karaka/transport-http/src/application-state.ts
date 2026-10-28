/** Durable application request receipts maintained by a retained Session projection. */
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition, ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-api-session-controller/types'
import { z } from 'zod'

/** Host-only state reconstructed from durable inbox and user-message events. */
export interface ApplicationState {
  /** Every admitted application request ID, including messages still in the inbox. */
  readonly requestIds: readonly string[]
}

const applicationProjection: ProjectionDefinition<'karakaApplication', ApplicationState> = {
  key: 'karakaApplication',
  stateVersion: 2,
  stateSchema: z.object({
    requestIds: z.array(z.string()),
  }),
  init: () => ({ requestIds: [] }),
  apply: foldApplicationState,
}

function foldApplicationState(state: ApplicationState, event: SessionEvent): ApplicationState {
  const messages = event.type === 'agent/inbox/spliced' ? event.data.inserted : event.type === 'user/message' ? [event.data] : []
  const ids = messages.flatMap(({ source }) => source.kind === 'user' && 'rpcId' in source ? [source.rpcId] : [])
  const added = ids.filter((id, index) => !state.requestIds.includes(id) && ids.indexOf(id) === index)
  return added.length === 0 ? state : { ...state, requestIds: [...state.requestIds, ...added] }
}

/**
 * Register application state under the calling plugin's lifecycle.
 * @param ctx - Context with the Session projection registry.
 * @returns The effect-owned registration and its retained state reader.
 */
export function installApplicationProjection(ctx: Context): Promise<ProjectionHandle<ApplicationState>> {
  return ctx.sessionProjections.register(applicationProjection)
}

/**
 * Read application state without scanning arbitrary Session event positions.
 * @param projection - Reader retained from the application projection registration.
 * @param session - Live or reconstructed Session to project.
 * @returns Current admission receipts.
 */
export function applicationState(projection: ProjectionHandle<ApplicationState>, session: Session): ApplicationState {
  return projection.stateOf(session)
}
