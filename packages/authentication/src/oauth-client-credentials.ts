import type { Context } from '@karaka/cordis'
import Schema from '@karaka/schemastery'
import {
  createRemoteJWKSet,
  importPKCS8,
  jwtVerify,
  SignJWT,
  type JWTVerifyGetKey,
} from 'jose'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import {
  AuthenticationService,
  AuthenticationError,
  type AuthenticatedServer,
  type AuthenticationDispatch,
  type AuthenticationProvider,
  type AuthenticationTarget,
} from './index.ts'

export type OAuthAlgorithm = 'RS256' | 'PS256' | 'ES256' | 'EdDSA'

const algorithms = ['RS256', 'PS256', 'ES256', 'EdDSA'] as const satisfies readonly OAuthAlgorithm[]

/** YAML-serializable OAuth 2.0 Client Credentials provider configuration. */
export interface Config {
  readonly name?: string
  readonly issuer: string
  readonly audience: string
  readonly tokenEndpoint: string
  readonly jwksUri: string
  readonly clientId: string
  readonly scopes?: string[]
  readonly algorithms?: OAuthAlgorithm[]
  readonly clientSecretEnv?: string
  readonly privateKeyPath?: string
  readonly privateKeyAlgorithm?: OAuthAlgorithm
  readonly privateKeyId?: string
  /** Advanced test or host hook. Normal deployments use global fetch. */
  readonly fetch?: typeof globalThis.fetch
}

export const Config: Schema<Config> = Schema.object({
  name: Schema.string().default('oauth-client-credentials'),
  issuer: Schema.string().required(),
  audience: Schema.string().required(),
  tokenEndpoint: Schema.string().required(),
  jwksUri: Schema.string().required(),
  clientId: Schema.string().required(),
  scopes: Schema.array(Schema.string()).default([]),
  algorithms: Schema.array(Schema.union([...algorithms])).default(['RS256']),
  clientSecretEnv: Schema.string(),
  privateKeyPath: Schema.string(),
  privateKeyAlgorithm: Schema.union([...algorithms]).default('RS256'),
  privateKeyId: Schema.string(),
})

interface AccessToken {
  readonly value: string
  readonly expiresAt: number
}

/** OAuth Client Credentials implementation for both incoming and outgoing server authentication. */
export class OAuthClientCredentialsProvider implements AuthenticationProvider {
  readonly name: string
  private readonly issuer: string
  private readonly audience: string
  private readonly tokenEndpoint: string
  private readonly jwks: JWTVerifyGetKey
  private readonly algorithms: readonly OAuthAlgorithm[]
  private readonly clientId: string
  private readonly scopes: readonly string[]
  private readonly fetch: typeof globalThis.fetch
  private readonly clientSecretEnv: string | undefined
  private readonly privateKeyPath: string | undefined
  private readonly privateKeyAlgorithm: OAuthAlgorithm
  private readonly privateKeyId: string | undefined
  private readonly tokens = new Map<string, AccessToken>()
  private readonly tokenRequests = new Map<string, Promise<AccessToken>>()
  private privateKey: ReturnType<typeof importPKCS8> | undefined

  constructor(config: Config) {
    if (!config || typeof config !== 'object') throw new TypeError('OAuth authentication configuration must be an object')
    this.name = requireText(config.name ?? 'oauth-client-credentials', 'provider name')
    this.issuer = requireUrl(config.issuer, 'OAuth issuer').href
    this.audience = requireText(config.audience, 'OAuth audience')
    this.tokenEndpoint = requireHttpUrl(config.tokenEndpoint, 'OAuth token endpoint').href
    const jwksUri = requireHttpUrl(config.jwksUri, 'OAuth JWKS URI')
    this.clientId = requireText(config.clientId, 'OAuth client ID')
    this.scopes = Object.freeze(uniqueText(config.scopes ?? [], 'OAuth scope'))
    this.algorithms = Object.freeze([...(config.algorithms ?? ['RS256'])])
    if (!this.algorithms.length || this.algorithms.some(value => !algorithms.includes(value))) {
      throw new TypeError('OAuth algorithms must contain supported asymmetric algorithms')
    }
    this.clientSecretEnv = optionalText(config.clientSecretEnv, 'OAuth client-secret environment variable')
    this.privateKeyPath = optionalText(config.privateKeyPath, 'OAuth private-key path')
    if (!!this.clientSecretEnv === !!this.privateKeyPath) {
      throw new TypeError('OAuth authentication requires exactly one of clientSecretEnv or privateKeyPath')
    }
    this.privateKeyAlgorithm = config.privateKeyAlgorithm ?? 'RS256'
    if (!algorithms.includes(this.privateKeyAlgorithm)) throw new TypeError('OAuth private-key algorithm is unsupported')
    this.privateKeyId = optionalText(config.privateKeyId, 'OAuth private-key ID')
    this.fetch = config.fetch ?? globalThis.fetch
    if (typeof this.fetch !== 'function') throw new TypeError('OAuth authentication requires fetch')
    this.jwks = createRemoteJWKSet(jwksUri)
  }

  async authenticate(request: Request): Promise<AuthenticatedServer> {
    const token = bearerToken(request.headers.get('authorization'))
    try {
      const { payload } = await jwtVerify(token, this.jwks, {
        issuer: this.issuer,
        audience: this.audience,
        algorithms: [...this.algorithms],
        requiredClaims: ['iss', 'sub', 'aud', 'exp'],
      })
      return Object.freeze({
        id: payload.sub!,
        provider: this.name,
        claims: Object.freeze({ ...payload }),
      })
    } catch (error) {
      throw new AuthenticationError('INVALID_CREDENTIAL', 'authentication failed', { cause: error })
    }
  }

  async request(
    target: Readonly<AuthenticationTarget>,
    request: Request,
    dispatch: AuthenticationDispatch,
  ): Promise<Response> {
    if (request.headers.has('authorization')) {
      throw new AuthenticationError('INVALID_REQUEST', 'outgoing request already contains authorization')
    }
    const token = await this.accessToken(requireText(target.audience, 'authentication audience'))
    const headers = new Headers(request.headers)
    headers.set('authorization', `Bearer ${token}`)
    return dispatch(new Request(request, { headers }))
  }

  private async accessToken(audience: string): Promise<string> {
    const current = this.tokens.get(audience)
    if (current && current.expiresAt - Date.now() > 30_000) return current.value
    const active = this.tokenRequests.get(audience)
    if (active) return (await active).value

    const acquiring = this.acquireToken(audience)
    this.tokenRequests.set(audience, acquiring)
    try {
      const token = await acquiring
      this.tokens.set(audience, token)
      return token.value
    } finally {
      if (this.tokenRequests.get(audience) === acquiring) this.tokenRequests.delete(audience)
    }
  }

  private async acquireToken(audience: string): Promise<AccessToken> {
    const body = new URLSearchParams({ grant_type: 'client_credentials', resource: audience })
    if (this.scopes.length) body.set('scope', this.scopes.join(' '))
    const headers = new Headers({
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
    })

    if (this.clientSecretEnv) {
      const secret = requireText(process.env[this.clientSecretEnv], `environment variable ${this.clientSecretEnv}`)
      headers.set('authorization', `Basic ${Buffer.from(`${this.clientId}:${secret}`).toString('base64')}`)
    } else {
      body.set('client_id', this.clientId)
      body.set('client_assertion_type', 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer')
      body.set('client_assertion', await this.clientAssertion())
    }

    let response: Response
    try {
      response = await this.fetch(this.tokenEndpoint, { method: 'POST', headers, body })
    } catch (cause) {
      throw new AuthenticationError('TOKEN_REQUEST_FAILED', 'OAuth token request failed', { cause })
    }
    if (!response.ok) throw new AuthenticationError('TOKEN_REQUEST_FAILED', 'OAuth token request was rejected')

    let value: unknown
    try {
      value = await response.json()
    } catch (cause) {
      throw new AuthenticationError('TOKEN_REQUEST_FAILED', 'OAuth token response is invalid', { cause })
    }
    if (!isRecord(value) || value.token_type?.toString().toLowerCase() !== 'bearer') {
      throw new AuthenticationError('TOKEN_REQUEST_FAILED', 'OAuth token response is invalid')
    }
    const token = requireText(value.access_token, 'OAuth access token')
    const expiresIn = value.expires_in
    if (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn <= 0) {
      throw new AuthenticationError('TOKEN_REQUEST_FAILED', 'OAuth token lifetime is invalid')
    }
    return Object.freeze({ value: token, expiresAt: Date.now() + expiresIn * 1_000 })
  }

  private async clientAssertion(): Promise<string> {
    this.privateKey ??= readFile(this.privateKeyPath!, 'utf8')
      .then(value => importPKCS8(value, this.privateKeyAlgorithm))
    const key = await this.privateKey
    const now = Math.floor(Date.now() / 1_000)
    return new SignJWT({})
      .setProtectedHeader({
        alg: this.privateKeyAlgorithm,
        ...(this.privateKeyId ? { kid: this.privateKeyId } : {}),
      })
      .setIssuer(this.clientId)
      .setSubject(this.clientId)
      .setAudience(this.tokenEndpoint)
      .setIssuedAt(now)
      .setExpirationTime(now + 60)
      .setJti(randomUUID())
      .sign(key)
  }
}

export const plugin = {
  name: 'authentication-oauth-client-credentials',
  Config,
  async apply(ctx: Context, config: Config) {
    await ctx.plugin(AuthenticationService)
    await ctx.plugin(providerPlugin, config)
  },
}

const providerPlugin = {
  name: 'authentication-oauth-client-credentials-provider',
  inject: ['authentication'],
  apply(ctx: Context, config: Config) {
    ctx.authentication.register(new OAuthClientCredentialsProvider(config))
  },
}

function bearerToken(value: string | null): string {
  const match = /^Bearer\s+(\S+)$/i.exec(value ?? '')
  if (!match) throw new AuthenticationError('INVALID_CREDENTIAL', 'authentication failed')
  return match[1]!
}

function uniqueText(values: readonly string[], label: string) {
  if (!Array.isArray(values)) throw new TypeError(`${label}s must be an array`)
  return [...new Set(values.map(value => requireText(value, label)))]
}

function optionalText(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : requireText(value, label)
}

function requireUrl(value: unknown, label: string): URL {
  const url = requireHttpUrl(value, label)
  if (url.search || url.hash) throw new TypeError(`${label} must not contain a query or fragment`)
  return url
}

function requireHttpUrl(value: unknown, label: string): URL {
  let url: URL
  try {
    url = new URL(requireText(value, label))
  } catch (cause) {
    throw new TypeError(`${label} is invalid`, { cause })
  }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
    throw new TypeError(`${label} must use HTTP or HTTPS without credentials`)
  }
  if (url.protocol === 'http:' && !['127.0.0.1', '::1', 'localhost'].includes(url.hostname)) {
    throw new TypeError(`${label} must use HTTPS unless it is a loopback test endpoint`)
  }
  return url
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function requireText(value: unknown, label: string): string {
  if (typeof value === 'string' && value.trim()) return value
  throw new TypeError(`${label} must be a non-empty string`)
}

export default plugin
