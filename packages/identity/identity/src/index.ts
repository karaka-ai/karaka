/**
 * Runtime identity service for trusted host calls and HTTP Bearer JWTs.
 * One concrete `ctx.identity` service normalizes both inputs into immutable
 * user and optional tenant identifiers without making authorization decisions.
 * @module @deepseek-ai/dsh-identity
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { Branded } from '@deepseek-ai/dsh-brand'
import z from '@deepseek-ai/schemastery'
import { createRemoteJWKSet, errors, jwtVerify, type JWTPayload } from 'jose'

/** Stable application user identifier normalized by the identity service. */
export type IdentityUserId = Branded<'IdentityUserId'>
/** Stable application tenant or workspace identifier normalized by the identity service. */
export type IdentityTenantId = Branded<'IdentityTenantId'>
/** Identity-provider namespace that issued a verified JWT. */
export type IdentityIssuer = Branded<'IdentityIssuer'>
/** Intended recipient named by a verified JWT. */
export type IdentityAudience = Branded<'IdentityAudience'>
/** Optional issuer-local JWT identifier. */
export type IdentityTokenId = Branded<'IdentityTokenId'>

/**
 * Brand a trusted host user id for identity resolution.
 * @param value - stable application-owned user id.
 * @returns the same string with the identity-user brand.
 */
export function IdentityUserId(value: string): IdentityUserId {
  return value as IdentityUserId
}

/**
 * Brand a trusted host tenant id for identity resolution.
 * @param value - stable application-owned tenant or workspace id.
 * @returns the same string with the identity-tenant brand.
 */
export function IdentityTenantId(value: string): IdentityTenantId {
  return value as IdentityTenantId
}

/** JSON values admitted in a verified JWT claim set. */
export type IdentityClaimValue =
  | null
  | boolean
  | number
  | string
  | readonly IdentityClaimValue[]
  | { readonly [key: string]: IdentityClaimValue }

/** Trusted same-process identity supplied by typed host code. */
export interface TrustedIdentityRequest {
  /** Select trusted same-process normalization. */
  readonly kind: 'trusted'
  /** Stable user id established by the host application. */
  readonly userId: IdentityUserId
  /** Optional active tenant established by the host application. */
  readonly tenantId?: IdentityTenantId
}

/** Raw HTTP Authorization input resolved through configured JWT verification. */
export interface HttpBearerIdentityRequest {
  /** Select strict HTTP Bearer parsing and JWT verification. */
  readonly kind: 'http-bearer'
  /** Raw HTTP Authorization value(s), as exposed by common server runtimes. */
  readonly authorization: string | readonly string[] | undefined
  /** Optional caller cancellation; a shared JWKS fetch may continue for the process-local cache. */
  readonly signal?: AbortSignal
}

/** Input accepted by {@link Identity.resolve}. */
export type ResolveIdentityRequest = TrustedIdentityRequest | HttpBearerIdentityRequest

/** Common normalized identity fields. */
export interface NormalizedIdentity {
  /** Stable application user id. */
  readonly userId: IdentityUserId
  /** Optional active application tenant or workspace. */
  readonly tenantId?: IdentityTenantId
}

/** Identity accepted directly from trusted same-process host code. */
export interface TrustedResolvedIdentity extends NormalizedIdentity {
  /** Identifies the trusted host path. */
  readonly source: 'trusted'
}

/** Identity derived from a verified HTTP Bearer JWT. */
export interface JwtResolvedIdentity extends NormalizedIdentity {
  /** Identifies the HTTP Bearer JWT path. */
  readonly source: 'http-bearer'
  /** Verified issuer. */
  readonly issuer: IdentityIssuer
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

/** Deeply immutable identity returned by {@link Identity.resolve}. */
export type ResolvedIdentity = TrustedResolvedIdentity | JwtResolvedIdentity

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

/** Safe identity error that never includes raw credentials or provider details. */
export class IdentityError extends Error {
  /**
   * @param code - stable machine-routing failure code.
   */
  constructor(readonly code: IdentityErrorCode) {
    super(ERROR_MESSAGES[code])
    this.name = 'IdentityError'
  }
}

/** Remote-JWKS JWT configuration. */
export interface JwtConfig {
  /** Exact trusted JWT issuer. */
  issuer: string
  /** One or more accepted JWT audiences. */
  audience: string | string[]
  /** Remote JSON Web Key Set endpoint. HTTPS is required except on loopback. */
  jwksUrl: string
  /** Explicit signature-algorithm allowlist, for example `['RS256']`. */
  algorithms: string[]
  /** JWKS request deadline in milliseconds. */
  timeoutMs?: number
  /** Minimum delay between successful JWKS refreshes in milliseconds. */
  cooldownMs?: number
  /** Maximum age of a successfully fetched JWKS in milliseconds. */
  cacheMaxAgeMs?: number
  /** Accepted NumericDate clock skew in seconds. */
  clockToleranceSeconds?: number
  /** Additional required claim names beyond `sub`, `iat`, and `exp`. */
  additionalRequiredClaims?: string[]
  /** Optional claim whose non-empty string value becomes `tenantId`. */
  tenantIdClaim?: string
}

/** Plugin configuration. Omit `jwt` for trusted same-process use only. */
export interface Config {
  /** Enables HTTP Bearer JWT verification when present. */
  jwt?: JwtConfig
}

const DEFAULT_JWKS_TIMEOUT_MS = 5_000
const DEFAULT_JWKS_COOLDOWN_MS = 30_000
const DEFAULT_JWKS_CACHE_MAX_AGE_MS = 600_000
const DEFAULT_CLOCK_TOLERANCE_SECONDS = 0
const BASE_REQUIRED_CLAIMS = Object.freeze(['sub', 'iat', 'exp'] as const)

interface IdentityJwtSpec {
  readonly issuer: string
  readonly audience: string | readonly string[]
  readonly jwksUrl: URL
  readonly algorithms: readonly string[]
  readonly timeoutMs: number
  readonly cooldownMs: number
  readonly cacheMaxAgeMs: number
  readonly clockToleranceSeconds: number
  readonly requiredClaims: readonly string[]
  readonly tenantIdClaim?: string
}

function requireNonEmpty(value: string, field: string): string {
  if (value.length === 0 || value.trim() !== value) {
    throw new TypeError(`${field} must be a non-empty string without surrounding whitespace`)
  }
  return value
}

function requireDuration(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative safe integer`)
  }
  return value
}

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
}

function resolveJwtSpec(config: JwtConfig): IdentityJwtSpec {
  const issuer = requireNonEmpty(config.issuer, 'jwt.issuer')
  const audience = Array.isArray(config.audience)
    ? Object.freeze(config.audience.map(value => requireNonEmpty(value, 'jwt.audience')))
    : requireNonEmpty(config.audience, 'jwt.audience')
  if (Array.isArray(audience) && audience.length === 0) {
    throw new TypeError('jwt.audience must contain at least one value')
  }
  if (config.algorithms.length === 0) {
    throw new TypeError('jwt.algorithms must contain at least one value')
  }
  const algorithms = Object.freeze(
    config.algorithms.map(value => requireNonEmpty(value, 'jwt.algorithms')),
  )
  const jwksUrl = new URL(config.jwksUrl)
  if (jwksUrl.username !== '' || jwksUrl.password !== '' || jwksUrl.hash !== '') {
    throw new TypeError('jwt.jwksUrl must not contain credentials or a fragment')
  }
  if (jwksUrl.protocol !== 'https:' && !(jwksUrl.protocol === 'http:' && isLoopback(jwksUrl.hostname))) {
    throw new TypeError('jwt.jwksUrl must use HTTPS (loopback HTTP is allowed for local development)')
  }
  const tenantIdClaim = config.tenantIdClaim === undefined
    ? undefined
    : requireNonEmpty(config.tenantIdClaim, 'jwt.tenantIdClaim')
  const additional = (config.additionalRequiredClaims ?? [])
    .map(value => requireNonEmpty(value, 'jwt.additionalRequiredClaims'))
  const requiredClaims = Object.freeze([
    ...new Set([
      ...BASE_REQUIRED_CLAIMS,
      ...additional,
      ...(tenantIdClaim === undefined ? [] : [tenantIdClaim]),
    ]),
  ])
  return Object.freeze({
    issuer,
    audience,
    jwksUrl,
    algorithms,
    timeoutMs: requireDuration(config.timeoutMs ?? DEFAULT_JWKS_TIMEOUT_MS, 'jwt.timeoutMs'),
    cooldownMs: requireDuration(config.cooldownMs ?? DEFAULT_JWKS_COOLDOWN_MS, 'jwt.cooldownMs'),
    cacheMaxAgeMs: requireDuration(
      config.cacheMaxAgeMs ?? DEFAULT_JWKS_CACHE_MAX_AGE_MS,
      'jwt.cacheMaxAgeMs',
    ),
    clockToleranceSeconds: requireDuration(
      config.clockToleranceSeconds ?? DEFAULT_CLOCK_TOLERANCE_SECONDS,
      'jwt.clockToleranceSeconds',
    ),
    requiredClaims,
    ...(tenantIdClaim === undefined ? {} : { tenantIdClaim }),
  })
}

function cloneClaim(value: IdentityClaimValue): IdentityClaimValue {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return Object.freeze(value.map(cloneClaim))
  const output = Object.create(null) as Record<string, IdentityClaimValue>
  for (const [key, child] of Object.entries(value)) output[key] = cloneClaim(child)
  return Object.freeze(output)
}

function bearerToken(value: string | readonly string[] | undefined): string {
  if (value === undefined || value.length === 0) {
    throw new IdentityError('IDENTITY_CREDENTIAL_MISSING')
  }
  let header: string
  if (typeof value === 'string') {
    header = value
  } else {
    const single = value[0]
    if (value.length !== 1 || single === undefined) {
      throw new IdentityError('IDENTITY_CREDENTIAL_MALFORMED')
    }
    header = single
  }
  const match = /^[\t ]*Bearer[\t ]+([^\s,]+)[\t ]*$/i.exec(header)
  const token = match?.[1]
  if (token !== undefined) return token
  const scheme = /^[\t ]*([^\s,]+)(?:[\t ]+|$)/.exec(header)?.[1]
  if (scheme !== undefined && scheme.toLowerCase() !== 'bearer') {
    throw new IdentityError('IDENTITY_CREDENTIAL_UNSUPPORTED')
  }
  throw new IdentityError('IDENTITY_CREDENTIAL_MALFORMED')
}

function invalidIdentity(): IdentityError {
  return new IdentityError('IDENTITY_CREDENTIAL_INVALID')
}

function verificationUnavailable(error: unknown): boolean {
  return !(error instanceof errors.JOSEError)
    || error.constructor === errors.JOSEError
    || error instanceof errors.JWKSTimeout
    || error instanceof errors.JWKSInvalid
    || error instanceof errors.JWKInvalid
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new IdentityError('IDENTITY_VERIFICATION_ABORTED')
}

function settleWithAbort<T>(operation: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return operation
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const finish = (): boolean => {
      if (settled) return false
      settled = true
      signal.removeEventListener('abort', abort)
      return true
    }
    const abort = (): void => {
      settled = true
      signal.removeEventListener('abort', abort)
      reject(new IdentityError('IDENTITY_VERIFICATION_ABORTED'))
    }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    operation.then(
      value => { if (finish()) resolve(value) },
      error => { if (finish()) reject(error) },
    )
  })
}

interface ValidatedJwtPayload extends JWTPayload {
  readonly iss: string
  readonly sub: string
  readonly aud: string | string[]
  readonly iat: number
  readonly exp: number
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    identity: Identity
  }
}

/** Identity service for trusted host values and configured HTTP Bearer JWTs. */
export class Identity extends Service {
  static Config: z<Config> = z.object({
    jwt: z.object({
      issuer: z.string().min(1).required(),
      audience: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).required(),
      jwksUrl: z.string().min(1).required(),
      algorithms: z.array(z.string().min(1)).min(1).required(),
      timeoutMs: z.number().step(1).min(0).default(DEFAULT_JWKS_TIMEOUT_MS),
      cooldownMs: z.number().step(1).min(0).default(DEFAULT_JWKS_COOLDOWN_MS),
      cacheMaxAgeMs: z.number().step(1).min(0).default(DEFAULT_JWKS_CACHE_MAX_AGE_MS),
      clockToleranceSeconds: z.number().step(1).min(0).default(DEFAULT_CLOCK_TOLERANCE_SECONDS),
      additionalRequiredClaims: z.array(z.string().min(1)).default([]),
      tenantIdClaim: z.string().min(1),
    }).default(undefined as never),
  }) as z<Config>

  private readonly jwtSpec: IdentityJwtSpec | undefined
  private readonly jwks: ReturnType<typeof createRemoteJWKSet> | undefined

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'identity')
    this.jwtSpec = config.jwt === undefined ? undefined : resolveJwtSpec(config.jwt)
    this.jwks = this.jwtSpec === undefined
      ? undefined
      : createRemoteJWKSet(this.jwtSpec.jwksUrl, {
        timeoutDuration: this.jwtSpec.timeoutMs,
        cooldownDuration: this.jwtSpec.cooldownMs,
        cacheMaxAge: this.jwtSpec.cacheMaxAgeMs,
      })
  }

  /**
   * Normalize a trusted host identity or verify one HTTP Bearer JWT.
   * Trusted input is detached and frozen without hostile validation. HTTP input
   * is parsed strictly, cancels caller settlement cooperatively, and fails with
   * `IDENTITY_VERIFICATION_UNAVAILABLE` when JWT configuration is absent.
   * Cancellation does not abort a shared remote-JWKS fetch, which may continue
   * to populate the process-local cache for other callers.
   * @param request - trusted host identity or raw HTTP Authorization input.
   * @returns one deeply immutable normalized identity.
   */
  async resolve(request: ResolveIdentityRequest): Promise<ResolvedIdentity> {
    switch (request.kind) {
      case 'trusted':
        return Object.freeze({
          source: 'trusted',
          userId: request.userId,
          ...(request.tenantId === undefined ? {} : { tenantId: request.tenantId }),
        })
      case 'http-bearer':
        return this.resolveHttpBearer(request)
      default:
        return this.unsupportedRequest(request)
    }
  }

  private unsupportedRequest(_request: never): never {
    throw new IdentityError('IDENTITY_CREDENTIAL_UNSUPPORTED')
  }

  private async resolveHttpBearer(request: HttpBearerIdentityRequest): Promise<JwtResolvedIdentity> {
    throwIfAborted(request.signal)
    const token = bearerToken(request.authorization)
    if (this.jwtSpec === undefined || this.jwks === undefined) {
      throw new IdentityError('IDENTITY_VERIFICATION_UNAVAILABLE')
    }

    try {
      const { payload } = await settleWithAbort(
        jwtVerify(token, this.jwks, {
          issuer: this.jwtSpec.issuer,
          audience: this.jwtSpec.audience as string | string[],
          algorithms: [...this.jwtSpec.algorithms],
          clockTolerance: this.jwtSpec.clockToleranceSeconds,
          requiredClaims: [...this.jwtSpec.requiredClaims],
        }),
        request.signal,
      )
      throwIfAborted(request.signal)
      return this.jwtIdentity(payload)
    } catch (error) {
      if (error instanceof IdentityError) throw error
      throw new IdentityError(
        verificationUnavailable(error)
          ? 'IDENTITY_VERIFICATION_UNAVAILABLE'
          : 'IDENTITY_CREDENTIAL_INVALID',
      )
    }
  }

  private jwtIdentity(payload: JWTPayload): JwtResolvedIdentity {
    if (
      typeof payload.sub !== 'string' || payload.sub.length === 0
      || typeof payload.iat !== 'number' || !Number.isFinite(payload.iat)
      || (payload.jti !== undefined && (typeof payload.jti !== 'string' || payload.jti.length === 0))
    ) {
      throw invalidIdentity()
    }
    const tenantId = this.jwtSpec?.tenantIdClaim === undefined
      ? undefined
      : payload[this.jwtSpec.tenantIdClaim]
    if (tenantId !== undefined && (typeof tenantId !== 'string' || tenantId.length === 0)) {
      throw invalidIdentity()
    }

    const verifiedPayload = payload as ValidatedJwtPayload
    const audiences = typeof verifiedPayload.aud === 'string'
      ? [verifiedPayload.aud]
      : verifiedPayload.aud
    const claims = cloneClaim(payload as unknown as IdentityClaimValue)
    return Object.freeze({
      source: 'http-bearer',
      userId: verifiedPayload.sub as IdentityUserId,
      ...(tenantId === undefined ? {} : { tenantId: tenantId as IdentityTenantId }),
      issuer: verifiedPayload.iss as IdentityIssuer,
      audiences: Object.freeze(audiences.map(value => value as IdentityAudience)),
      issuedAt: verifiedPayload.iat,
      expiresAt: verifiedPayload.exp,
      ...(verifiedPayload.nbf === undefined ? {} : { notBefore: verifiedPayload.nbf }),
      ...(verifiedPayload.jti === undefined ? {} : {
        tokenId: verifiedPayload.jti as IdentityTokenId,
      }),
      claims: claims as Readonly<Record<string, IdentityClaimValue>>,
    })
  }
}

export default Identity
