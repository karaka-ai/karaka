import type { Context } from '@karaka/cordis'
import Schema from '@karaka/schemastery'
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose'
import {
  AuthenticationError,
  type AuthenticatedIdentity,
  type AuthenticationProvider,
  type AuthenticationRequest,
} from './index.ts'

/** Asymmetric signature algorithms accepted by the JWKS provider. */
export type JwksAlgorithm =
  | 'RS256'
  | 'RS384'
  | 'RS512'
  | 'PS256'
  | 'PS384'
  | 'PS512'
  | 'ES256'
  | 'ES384'
  | 'ES512'
  | 'EdDSA'

const algorithms = [
  'RS256',
  'RS384',
  'RS512',
  'PS256',
  'PS384',
  'PS512',
  'ES256',
  'ES384',
  'ES512',
  'EdDSA',
] as const satisfies readonly JwksAlgorithm[]

/** Verification configuration for one application tenant. */
export interface JwksTenantConfig {
  issuer: string
  audience: string | string[]
  jwksUri: string
  algorithms?: JwksAlgorithm[]
  tenantClaim?: string
  tenantValue?: string
}

/** YAML-serializable JWKS provider configuration. */
export interface Config {
  name?: string
  tenants: Record<string, JwksTenantConfig>
}

const Audience = Schema.union([
  Schema.string(),
  Schema.array(Schema.string()),
]).required()

const Tenant = Schema.object({
  issuer: Schema.string().required(),
  audience: Audience,
  jwksUri: Schema.string().required(),
  algorithms: Schema.array(Schema.union([...algorithms])).default(['RS256']),
  tenantClaim: Schema.string(),
  tenantValue: Schema.string(),
})

export const Config: Schema<Config> = Schema.object({
  name: Schema.string().default('jwks'),
  tenants: Schema.dict(Tenant).required(),
})

interface TenantRuntime {
  issuer: string
  audience: string[]
  algorithms: JwksAlgorithm[]
  tenantClaim?: string
  tenantValue?: string
  key: JWTVerifyGetKey
}

/** Tenant-aware JWT verifier backed only by configured remote JWKS endpoints. */
export class JwksAuthenticationProvider implements AuthenticationProvider {
  readonly name: string
  readonly tenantIds: readonly string[]
  private readonly tenants = new Map<string, TenantRuntime>()

  constructor(config: Config) {
    this.name = requireText(config.name ?? 'jwks', 'provider name')
    this.tenantIds = Object.freeze(Object.keys(config.tenants))
    if (!this.tenantIds.length) throw new TypeError('JWKS authentication requires at least one tenant')

    for (const tenantId of this.tenantIds) {
      requireText(tenantId, 'tenant ID')
      const tenant = config.tenants[tenantId]!
      validateTenant(tenantId, tenant)
      this.tenants.set(tenantId, {
        ...tenant,
        audience: normalizeAudience(tenant.audience),
        algorithms: [...(tenant.algorithms ?? ['RS256'])],
        key: createRemoteJWKSet(new URL(tenant.jwksUri)),
      })
    }
    validateTenantIsolation(config.tenants)
  }

  async authenticate(request: Readonly<AuthenticationRequest>): Promise<AuthenticatedIdentity> {
    const tenant = this.tenants.get(request.tenantId)
    if (!tenant) throw new AuthenticationError('UNKNOWN_TENANT', 'authentication failed')

    try {
      const { payload } = await jwtVerify(request.token, tenant.key, {
        issuer: tenant.issuer,
        audience: tenant.audience,
        algorithms: tenant.algorithms,
        requiredClaims: ['iss', 'sub', 'aud', 'exp'],
      })
      if (tenant.tenantClaim && payload[tenant.tenantClaim] !== tenant.tenantValue) {
        throw new Error('tenant claim mismatch')
      }
      return Object.freeze({
        tenantId: request.tenantId,
        subject: payload.sub!,
        provider: this.name,
        claims: Object.freeze({ ...payload }),
      })
    } catch (error) {
      throw new AuthenticationError('INVALID_TOKEN', 'authentication failed', { cause: error })
    }
  }
}

export const plugin = {
  name: 'authentication-jwks',
  inject: ['authentication'],
  Config,
  apply(ctx: Context, config: Config) {
    ctx.authentication.register(new JwksAuthenticationProvider(config))
  },
}

function validateTenant(tenantId: string, tenant: JwksTenantConfig) {
  requireText(tenant.issuer, `issuer for tenant "${tenantId}"`)
  const jwksUrl = new URL(requireText(tenant.jwksUri, `JWKS URI for tenant "${tenantId}"`))
  if (jwksUrl.protocol !== 'https:' && jwksUrl.protocol !== 'http:') {
    throw new TypeError(`JWKS URI for tenant "${tenantId}" must use HTTP or HTTPS`)
  }

  const audience = normalizeAudience(tenant.audience)
  if (!audience.length || audience.some(value => !value.trim())) {
    throw new TypeError(`audience for tenant "${tenantId}" must contain non-empty strings`)
  }
  if (tenant.algorithms && !tenant.algorithms.length) {
    throw new TypeError(`algorithms for tenant "${tenantId}" must not be empty`)
  }
  if ((tenant.tenantClaim === undefined) !== (tenant.tenantValue === undefined)) {
    throw new TypeError(`tenantClaim and tenantValue for tenant "${tenantId}" must be configured together`)
  }
  if (tenant.tenantClaim !== undefined) {
    requireText(tenant.tenantClaim, `tenantClaim for tenant "${tenantId}"`)
    requireText(tenant.tenantValue, `tenantValue for tenant "${tenantId}"`)
  }
}

function validateTenantIsolation(tenants: Record<string, JwksTenantConfig>) {
  const entries = Object.entries(tenants)
  for (let leftIndex = 0; leftIndex < entries.length; leftIndex++) {
    const [leftId, left] = entries[leftIndex]!
    const leftAudience = new Set(normalizeAudience(left.audience))
    for (let rightIndex = leftIndex + 1; rightIndex < entries.length; rightIndex++) {
      const [rightId, right] = entries[rightIndex]!
      if (left.issuer !== right.issuer) continue
      if (!normalizeAudience(right.audience).some(value => leftAudience.has(value))) continue
      const claimsSeparateTenants = left.tenantClaim
        && right.tenantClaim
        && (left.tenantClaim !== right.tenantClaim || left.tenantValue !== right.tenantValue)
      if (!claimsSeparateTenants) {
        throw new TypeError(
          `tenants "${leftId}" and "${rightId}" share issuer and audience; configure distinct tenant claims`,
        )
      }
    }
  }
}

function normalizeAudience(audience: string | string[]) {
  return typeof audience === 'string' ? [audience] : [...audience]
}

function requireText(value: unknown, label: string): string {
  if (typeof value === 'string' && value.trim()) return value
  throw new TypeError(`${label} must be a non-empty string`)
}

export default plugin
