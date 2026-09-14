/** Constructors and comparisons for authenticated Karaka ownership. */
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'

/** Authenticated application server identity. */
export type ApplicationId = Branded<'ApplicationId'>
/** Tenant identity asserted by an authenticated application server. */
export type TenantId = Branded<'TenantId'>
/** User identity asserted by an authenticated application server. */
export type UserId = Branded<'UserId'>

/** Immutable application ownership established by authenticated ingress. */
export interface ApplicationOwner {
  /** Authenticated application server. */
  readonly applicationId: ApplicationId
  /** Tenant asserted by that application. */
  readonly tenantId: TenantId
  /** User within that application and tenant. */
  readonly userId: UserId
}

/**
 * Brand an application identifier after ingress validation.
 * @param value - Validated application identifier.
 * @returns Its branded value.
 */
export function ApplicationId(value: string): ApplicationId { return brandString<ApplicationId>(value) }
/**
 * Brand a tenant identifier after ingress validation.
 * @param value - Validated tenant identifier.
 * @returns Its branded value.
 */
export function TenantId(value: string): TenantId { return brandString<TenantId>(value) }
/**
 * Brand a user identifier after ingress validation.
 * @param value - Validated user identifier.
 * @returns Its branded value.
 */
export function UserId(value: string): UserId { return brandString<UserId>(value) }

/**
 * Compare all three components of application ownership.
 * @param left - First owner.
 * @param right - Second owner.
 * @returns Whether every identity agrees.
 */
export function sameOwner(left: ApplicationOwner, right: ApplicationOwner): boolean {
  return left.applicationId === right.applicationId && left.tenantId === right.tenantId && left.userId === right.userId
}

/** Authorization failures expose no other owner's identity. */
export class IdentityError extends Error {
  constructor(readonly code: 'forbidden' | 'unavailable', message: string) {
    super(message)
    this.name = 'IdentityError'
  }
}
