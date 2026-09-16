/** Durable Karaka authority records, separate from original DSH JSONL. */
import { z } from 'zod'
import { pick } from '@deepseek-ai/cosmokit'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { SessionId, type SessionHeader } from '@deepseek-ai/dsh-session'
import { ApplicationId, TenantId, UserId } from './owner.ts'

const ownerSchema = z.object({
  applicationId: z.string().min(1).transform(ApplicationId),
  tenantId: z.string().min(1).transform(TenantId),
  userId: z.string().min(1).transform(UserId),
}).strict()

const bindingSchema = z.object({
  id: z.string().min(1).transform(SessionId),
  createdAt: z.number().int().nonnegative(),
  cwd: z.string().optional(),
  parentSession: z.string().min(1).transform(SessionId).optional(),
  isSeeded: z.boolean(),
  origin: z.literal('subagent').optional(),
  delegationDepth: z.number().int().nonnegative(),
  agentPreset: z.string().optional(),
}).strict()

const recordSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('reserved'), owner: ownerSchema }).strict(),
  z.object({ state: z.literal('bound'), owner: ownerSchema, binding: bindingSchema }).strict(),
  z.object({ state: z.literal('ready'), owner: ownerSchema, binding: bindingSchema }).strict(),
])

/** The one authority file is versioned independently of DSH's Session format. */
export const identityDomain = defineDomain({
  name: 'karaka_identity',
  version: 1,
  tables: { chats: domainTable<SessionId, z.infer<typeof recordSchema>>(recordSchema) },
})

/** Creation state and immutable binding admitted by the durable schema. */
export type IdentityRecord = z.infer<typeof recordSchema>

/**
 * Physical format versions may change through upstream migrations; source identity cannot.
 * @param header - Original DSH immutable header.
 * @returns Stable logical fields identifying that Session.
 */
export function bindingOf(header: SessionHeader): z.infer<typeof bindingSchema> {
  return {
    ...pick(header, bindingSchema.keyof().options),
    delegationDepth: header.delegationDepth ?? 0,
  }
}

/**
 * Compare durable authority with the observed immutable Session fields.
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
