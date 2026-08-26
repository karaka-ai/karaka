/**
 * Provider-neutral identity-verification Service Definition (`ctx.identity`).
 * Providers verify credentials; Consumers receive an immutable identity but do
 * not infer tenant membership, application roles, or resource permissions.
 * @module @deepseek-ai/dsh-identity
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Identity-provider namespace that issued a verified credential. */
export type IdentityIssuer = Branded<'IdentityIssuer'>
/** Issuer-local subject named by a verified credential. */
export type IdentitySubject = Branded<'IdentitySubject'>
/** Intended recipient named by a verified credential. */
export type IdentityAudience = Branded<'IdentityAudience'>
/** Optional issuer-local token identifier. */
export type IdentityTokenId = Branded<'IdentityTokenId'>

/** JSON values admitted in a verified JWT claim set. */
export type IdentityClaimValue =
  | null
  | boolean
  | number
  | string
  | readonly IdentityClaimValue[]
  | { readonly [key: string]: IdentityClaimValue }

/** Credential kinds understood by identity providers. */
export interface BearerIdentityCredential {
  /** Select bearer-token verification. */
  readonly kind: 'bearer'
  /** Opaque credential; callers and errors must never log or serialize it. */
  readonly token: string
}

/** Input to {@link Identity.verify}. */
export interface VerifyIdentityRequest {
  /** Provider-neutral credential envelope. */
  readonly credential: BearerIdentityCredential
  /** Optional cooperative cancellation. */
  readonly signal?: AbortSignal
}

/** Trusted claims after cryptographic and registered-claim verification. */
export interface VerifiedIdentity {
  /** Verified issuer. */
  readonly issuer: IdentityIssuer
  /** Verified issuer-local subject. */
  readonly subject: IdentitySubject
  /** Every verified intended recipient, normalized to an immutable array. */
  readonly audiences: readonly IdentityAudience[]
  /** Issuance time as NumericDate seconds. */
  readonly issuedAt: number
  /** Expiration time as NumericDate seconds. */
  readonly expiresAt: number
  /** Optional not-before time as NumericDate seconds. */
  readonly notBefore?: number
  /** Optional issuer-local token identifier. */
  readonly tokenId?: IdentityTokenId
  /** Deeply immutable verified claim set. */
  readonly claims: Readonly<Record<string, IdentityClaimValue>>
}

/** Stable identity failures suitable for transport error routing. */
export type IdentityErrorCode =
  | 'IDENTITY_CREDENTIAL_MISSING'
  | 'IDENTITY_CREDENTIAL_MALFORMED'
  | 'IDENTITY_CREDENTIAL_UNSUPPORTED'
  | 'IDENTITY_CREDENTIAL_INVALID'
  | 'IDENTITY_VERIFICATION_UNAVAILABLE'
  | 'IDENTITY_VERIFICATION_ABORTED'

const ERROR_MESSAGES: Readonly<Record<IdentityErrorCode, string>> = Object.freeze({
  IDENTITY_CREDENTIAL_MISSING: 'identity credential is missing',
  IDENTITY_CREDENTIAL_MALFORMED: 'identity credential is malformed',
  IDENTITY_CREDENTIAL_UNSUPPORTED: 'identity credential type is unsupported',
  IDENTITY_CREDENTIAL_INVALID: 'identity credential is invalid',
  IDENTITY_VERIFICATION_UNAVAILABLE: 'identity verification is unavailable',
  IDENTITY_VERIFICATION_ABORTED: 'identity verification was aborted',
})

/** Safe capability error that never includes raw credential or provider details. */
export class IdentityError extends Error {
  /**
   * @param code - stable machine-routing failure code.
   */
  constructor(readonly code: IdentityErrorCode) {
    super(ERROR_MESSAGES[code])
    this.name = 'IdentityError'
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    identity: Identity
  }
}

/** Replaceable credential verifier. */
export abstract class Identity extends Service {
  constructor(ctx: Context) {
    super(ctx, 'identity')
  }

  /**
   * Verify one credential and return only cryptographically trusted identity
   * claims. Authority normalization and authorization are separate seams.
   * @param request - credential envelope and optional cancellation.
   * @returns deeply immutable verified identity claims.
   */
  abstract verify(request: VerifyIdentityRequest): Promise<VerifiedIdentity>
}

export default Identity
