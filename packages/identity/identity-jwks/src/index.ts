/**
 * Remote-JWKS JWT provider for `ctx.identity`.
 * @module @deepseek-ai/dsh-identity-jwks
 */

import { Context } from '@deepseek-ai/cordis'
import {
  Identity,
  IdentityError,
  type IdentityAudience,
  type IdentityClaimValue,
  type IdentityIssuer,
  type IdentitySubject,
  type IdentityTokenId,
  type VerifiedIdentity,
  type VerifyIdentityRequest,
} from '@deepseek-ai/dsh-identity'
import z from '@deepseek-ai/schemastery'
import { createRemoteJWKSet, errors, jwtVerify, type JWTPayload } from 'jose'

/** Default JWKS request deadline. */
export const DEFAULT_JWKS_TIMEOUT_MS = 5_000
/** Default minimum delay between successful JWKS refreshes. */
export const DEFAULT_JWKS_COOLDOWN_MS = 30_000
/** Default maximum age of a successfully fetched JWKS. */
export const DEFAULT_JWKS_CACHE_MAX_AGE_MS = 600_000
/** Default clock skew accepted while validating NumericDate claims. */
export const DEFAULT_CLOCK_TOLERANCE_SECONDS = 0
/** Claims every provider instance requires in addition to issuer and audience. */
export const BASE_REQUIRED_CLAIMS = Object.freeze(['sub', 'iat', 'exp'] as const)

/** Plugin configuration. */
export interface Config {
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
}

/** Fully resolved provider configuration. */
export interface IdentityJwksSpec {
  readonly issuer: string
  readonly audience: string | readonly string[]
  readonly jwksUrl: URL
  readonly algorithms: readonly string[]
  readonly timeoutMs: number
  readonly cooldownMs: number
  readonly cacheMaxAgeMs: number
  readonly clockToleranceSeconds: number
  readonly requiredClaims: readonly string[]
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

/**
 * Resolve defaults and constraints once before provider work begins.
 * @param config - raw plugin configuration from Loader or direct mounting.
 * @returns immutable validated provider configuration with explicit defaults.
 */
export function resolveIdentityJwksSpec(config: Config): IdentityJwksSpec {
  const issuer = requireNonEmpty(config.issuer, 'issuer')
  const audience = Array.isArray(config.audience)
    ? Object.freeze(config.audience.map(value => requireNonEmpty(value, 'audience')))
    : requireNonEmpty(config.audience, 'audience')
  if (Array.isArray(audience) && audience.length === 0) {
    throw new TypeError('audience must contain at least one value')
  }
  if (config.algorithms.length === 0) {
    throw new TypeError('algorithms must contain at least one value')
  }
  const algorithms = Object.freeze(config.algorithms.map(value => requireNonEmpty(value, 'algorithms')))
  const jwksUrl = new URL(config.jwksUrl)
  if (jwksUrl.username !== '' || jwksUrl.password !== '' || jwksUrl.hash !== '') {
    throw new TypeError('jwksUrl must not contain credentials or a fragment')
  }
  if (jwksUrl.protocol !== 'https:' && !(jwksUrl.protocol === 'http:' && isLoopback(jwksUrl.hostname))) {
    throw new TypeError('jwksUrl must use HTTPS (loopback HTTP is allowed for local development)')
  }
  const additional = (config.additionalRequiredClaims ?? [])
    .map(value => requireNonEmpty(value, 'additionalRequiredClaims'))
  const requiredClaims = Object.freeze([...new Set([...BASE_REQUIRED_CLAIMS, ...additional])])
  return Object.freeze({
    issuer,
    audience,
    jwksUrl,
    algorithms,
    timeoutMs: requireDuration(config.timeoutMs ?? DEFAULT_JWKS_TIMEOUT_MS, 'timeoutMs'),
    cooldownMs: requireDuration(config.cooldownMs ?? DEFAULT_JWKS_COOLDOWN_MS, 'cooldownMs'),
    cacheMaxAgeMs: requireDuration(
      config.cacheMaxAgeMs ?? DEFAULT_JWKS_CACHE_MAX_AGE_MS,
      'cacheMaxAgeMs',
    ),
    clockToleranceSeconds: requireDuration(
      config.clockToleranceSeconds ?? DEFAULT_CLOCK_TOLERANCE_SECONDS,
      'clockToleranceSeconds',
    ),
    requiredClaims,
  })
}

function cloneClaim(value: IdentityClaimValue): IdentityClaimValue {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return Object.freeze(value.map(cloneClaim))
  const output = Object.create(null) as Record<string, IdentityClaimValue>
  for (const [key, child] of Object.entries(value)) output[key] = cloneClaim(child)
  return Object.freeze(output)
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

interface ValidatedJwtPayload extends JWTPayload {
  readonly iss: string
  readonly sub: string
  readonly aud: string | string[]
  readonly iat: number
  readonly exp: number
}

/** Remote-JWKS verifier implementing the provider-neutral identity service. */
export class JwksIdentity extends Identity {
  static Config: z<Config> = z.object({
    issuer: z.string().min(1).required(),
    audience: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).required(),
    jwksUrl: z.string().min(1).required(),
    algorithms: z.array(z.string().min(1)).min(1).required(),
    timeoutMs: z.number().step(1).min(0).default(DEFAULT_JWKS_TIMEOUT_MS),
    cooldownMs: z.number().step(1).min(0).default(DEFAULT_JWKS_COOLDOWN_MS),
    cacheMaxAgeMs: z.number().step(1).min(0).default(DEFAULT_JWKS_CACHE_MAX_AGE_MS),
    clockToleranceSeconds: z.number().step(1).min(0).default(DEFAULT_CLOCK_TOLERANCE_SECONDS),
    additionalRequiredClaims: z.array(z.string().min(1)).default([]),
  })

  private readonly spec: IdentityJwksSpec
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>

  constructor(ctx: Context, config: Config) {
    super(ctx)
    this.spec = resolveIdentityJwksSpec(config)
    this.jwks = createRemoteJWKSet(this.spec.jwksUrl, {
      timeoutDuration: this.spec.timeoutMs,
      cooldownDuration: this.spec.cooldownMs,
      cacheMaxAge: this.spec.cacheMaxAgeMs,
    })
  }

  async verify(request: VerifyIdentityRequest): Promise<VerifiedIdentity> {
    throwIfAborted(request.signal)
    const credential = request.credential as { readonly kind?: unknown; readonly token?: unknown }
    if (credential.kind !== 'bearer' || typeof credential.token !== 'string' || credential.token.length === 0) {
      throw invalidIdentity()
    }
    const token = credential.token

    try {
      const { payload } = await jwtVerify(token, this.jwks, {
        issuer: this.spec.issuer,
        audience: this.spec.audience as string | string[],
        algorithms: [...this.spec.algorithms],
        clockTolerance: this.spec.clockToleranceSeconds,
        requiredClaims: [...this.spec.requiredClaims],
      })
      throwIfAborted(request.signal)

      if (
        typeof payload.sub !== 'string' || payload.sub.length === 0
        || typeof payload.iat !== 'number' || !Number.isFinite(payload.iat)
        || (payload.jti !== undefined && (typeof payload.jti !== 'string' || payload.jti.length === 0))
      ) {
        throw invalidIdentity()
      }
      const verifiedPayload = payload as ValidatedJwtPayload
      const audiences = typeof verifiedPayload.aud === 'string'
        ? [verifiedPayload.aud]
        : verifiedPayload.aud
      const claims = cloneClaim(payload as unknown as IdentityClaimValue)
      return Object.freeze({
        issuer: verifiedPayload.iss as IdentityIssuer,
        subject: verifiedPayload.sub as IdentitySubject,
        audiences: Object.freeze(audiences.map(value => value as IdentityAudience)),
        issuedAt: verifiedPayload.iat,
        expiresAt: verifiedPayload.exp,
        ...(verifiedPayload.nbf === undefined ? {} : { notBefore: verifiedPayload.nbf }),
        ...(verifiedPayload.jti === undefined ? {} : {
          tokenId: verifiedPayload.jti as IdentityTokenId,
        }),
        claims: claims as Readonly<Record<string, IdentityClaimValue>>,
      })
    } catch (error) {
      if (error instanceof IdentityError) throw error
      if (request.signal?.aborted === true) {
        throw new IdentityError('IDENTITY_VERIFICATION_ABORTED')
      }
      throw new IdentityError(
        verificationUnavailable(error)
          ? 'IDENTITY_VERIFICATION_UNAVAILABLE'
          : 'IDENTITY_CREDENTIAL_INVALID',
      )
    }
  }
}

export default JwksIdentity
