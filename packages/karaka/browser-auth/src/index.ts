/** Verify application-issued JWTs before they enter the browser connection. */

import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { importSPKI, jwtVerify, errors } from 'jose'
import { ApplicationId, TenantId, UserId } from '@karaka-ai/identity'
import type { ApplicationOwner } from '@karaka-ai/identity'

export interface BrowserCaller { readonly kind: 'application'; readonly owner: ApplicationOwner; readonly expiresAt: number }
declare module '@deepseek-ai/cordis' { interface Context { karakaBrowserAuth: BrowserAuthentication } }

export const name = 'karaka-browser-auth'

/** Public verification keys and required credential claims. */
export interface Config {
  /** Exact application identity accepted by this deployment. */
  readonly applicationId: string
  /** Required JWT issuer. */
  readonly issuer: string
  /** Required JWT audience. */
  readonly audience: string
  /** Maximum age and issued lifetime, in seconds. */
  readonly maxTokenAgeSeconds: number
  /** Public verification keys indexed by the protected JWT key id. */
  readonly keys: {
    /** Unique protected JWT key id. */
    readonly id: string
    /** Signature algorithm accepted for this key. */
    readonly algorithm: 'ES256' | 'RS256' | 'EdDSA'
    /** SPKI PEM public key; private signing keys remain in the backend. */
    readonly publicKey: string
  }[]
}

export const Config: z<Config> = z.object({
  applicationId: z.string().min(1).required(),
  issuer: z.string().min(1).required(),
  audience: z.string().min(1).required(),
  maxTokenAgeSeconds: z.natural().min(1).max(2_147_483).required(),
  keys: z.array(z.object({ id: z.string().min(1).required(), algorithm: z.union(['ES256', 'RS256', 'EdDSA']).required(), publicKey: z.string().min(1).required() })).min(1).required(),
})

/**
 * Validate public keys and provide the Connection credential verifier.
 * @param ctx - provider-owning context.
 * @param config - trusted application, issuer, audience, lifetime and public keys.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const keys = new Map<string, { algorithm: string; key: CryptoKey }>()
  for (const entry of config.keys) {
    if (keys.has(entry.id)) throw new Error('browser-auth: verification key ids must be unique')
    keys.set(entry.id, {
      algorithm: entry.algorithm, key: await importSPKI(entry.publicKey, entry.algorithm),
    })
  }
  new BrowserAuthentication(ctx, config, keys)
}

export class BrowserAuthentication extends Service {
  constructor(
    ctx: Context, private readonly config: Config,
    private readonly keys: ReadonlyMap<string, { algorithm: string; key: CryptoKey }>,
  ) {
    super(ctx, 'karakaBrowserAuth')
  }

  async authenticate(credential: string): Promise<BrowserCaller | undefined> {
    const config = this.config
    try {
      const { payload } = await jwtVerify(credential, (header) => {
        const entry = header.kid === undefined ? undefined : this.keys.get(header.kid)
        if (entry === undefined || entry.algorithm !== header.alg) throw new errors.JWSSignatureVerificationFailed()
        return entry.key
      }, {
        issuer: config.issuer,
        audience: config.audience,
        algorithms: [...new Set([...this.keys.values()].map(entry => entry.algorithm))],
        requiredClaims: ['exp', 'iat', 'applicationId', 'tenantId', 'userId'],
        maxTokenAge: config.maxTokenAgeSeconds,
      })
      const { applicationId, tenantId, userId, exp, iat } = payload
      if (applicationId !== config.applicationId || typeof tenantId !== 'string' || tenantId.length === 0
        || typeof userId !== 'string' || userId.length === 0 || typeof exp !== 'number' || typeof iat !== 'number'
        || !Number.isFinite(exp) || !Number.isFinite(iat) || exp <= iat || exp - iat > config.maxTokenAgeSeconds) return undefined
      return { kind: 'application', owner: { applicationId: ApplicationId(applicationId), tenantId: TenantId(tenantId), userId: UserId(userId) }, expiresAt: exp * 1000 }
    } catch (error) {
      if (error instanceof errors.JOSEError) return undefined
      throw error
    }
  }
}
