/** Process-local ownership records and immutable Session source comparisons. */
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import type { ApplicationOwner } from './owner.ts'

/** Immutable logical Session fields; physical format version is excluded. */
export type SessionBinding = {
  [Field in 'id' | 'createdAt' | 'cwd' | 'parentSession' | 'isSeeded' | 'origin' | 'agentPreset']: SessionHeader[Field]
} & { delegationDepth: number }

/** Ownership recorded before publication, after binding, or after durable acknowledgement. */
export type IdentityRecord =
  | { state: 'reserved'; owner: ApplicationOwner }
  | { state: 'bound' | 'ready'; owner: ApplicationOwner; binding: SessionBinding }

/**
 * Snapshot immutable logical fields independently of physical format migrations.
 * @param header - Original DSH immutable header.
 * @returns Fields identifying the bound Session.
 */
export function bindingOf(header: SessionHeader): SessionBinding {
  return {
    id: header.id,
    createdAt: header.createdAt,
    cwd: header.cwd,
    parentSession: header.parentSession,
    isSeeded: header.isSeeded,
    origin: header.origin,
    delegationDepth: header.delegationDepth ?? 0,
    agentPreset: header.agentPreset,
  }
}

/**
 * Compare recorded authority with the observed immutable Session fields.
 * @param record - Bound authority.
 * @param header - Observed original header.
 * @returns Whether all immutable fields match.
 */
export function matchesBinding(record: Exclude<IdentityRecord, { state: 'reserved' }>, header: SessionHeader): boolean {
  const left = record.binding
  const right = bindingOf(header)
  return left.id === right.id && left.createdAt === right.createdAt && left.cwd === right.cwd
    && left.parentSession === right.parentSession && left.isSeeded === right.isSeeded
    && left.origin === right.origin && left.delegationDepth === right.delegationDepth && left.agentPreset === right.agentPreset
}
