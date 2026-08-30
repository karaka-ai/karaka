import { Service, type Context } from '@karaka/cordis'
import { AsyncLocalStorage } from 'node:async_hooks'

declare module '@karaka/cordis' {
  interface Context {
    authentication: AuthenticationService
  }
}

/** Identity of a server established by the active authentication provider. */
export interface AuthenticatedServer {
  readonly id: string
  readonly provider: string
  readonly claims: Readonly<Record<string, unknown>>
}

/** User context asserted by an authenticated application server. */
export interface TrustedUserContext {
  readonly tenantId: string
  readonly userId: string
  readonly claims?: Readonly<Record<string, unknown>>
}

/** Request-local identity consumed by sessions, entitlement, and policy. */
export interface AuthenticatedIdentity {
  readonly tenantId: string
  readonly subject: string
  readonly provider: string
  readonly claims: Readonly<Record<string, unknown>>
}

/** Logical protected resource for an outgoing server request. */
export interface AuthenticationTarget {
  readonly audience: string
}

/** Unauthenticated carrier dispatch supplied by the protocol consumer. */
export type AuthenticationDispatch = (request: Request) => Promise<Response>

/** Header used internally to carry user context over an authenticated server request. */
export const TRUSTED_USER_CONTEXT_HEADER = 'x-karaka-user-context'

/** One server-authentication implementation contributed by a Cordis plugin. */
export interface AuthenticationProvider {
  readonly name: string
  authenticate(request: Request): Promise<AuthenticatedServer>
  request(
    target: Readonly<AuthenticationTarget>,
    request: Request,
    dispatch: AuthenticationDispatch,
  ): Promise<Response>
}

/** Stable authentication failures consumers may handle without provider coupling. */
export type AuthenticationErrorCode =
  | 'INVALID_REQUEST'
  | 'NO_PROVIDER'
  | 'NO_CURRENT_PRINCIPAL'
  | 'INVALID_CREDENTIAL'
  | 'INVALID_IDENTITY'
  | 'TOKEN_REQUEST_FAILED'

/** Provider-neutral authentication failure. */
export class AuthenticationError extends Error {
  override readonly name = 'AuthenticationError'

  constructor(
    readonly code: AuthenticationErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
  }
}

/** Read-only description of the active provider. */
export interface AuthenticationProviderDescriptor {
  readonly name: string
}

interface RegisteredProvider {
  readonly name: string
  readonly implementation: AuthenticationProvider
}

/**
 * One provider-neutral server-authentication boundary.
 *
 * A provider plugin owns the incoming verifier and outgoing authenticated
 * request path. User identity is trusted request data supplied by a server
 * after that server has been authenticated.
 */
export class AuthenticationService extends Service {
  private readonly invocationPrincipal = new AsyncLocalStorage<AuthenticatedIdentity>()
  private provider: RegisteredProvider | undefined

  constructor(ctx: Context) {
    super(ctx, 'authentication')
  }

  /** Register the one active provider until its contributing plugin unloads. */
  register(provider: AuthenticationProvider) {
    const name = requireText(provider?.name, 'provider name')
    if (typeof provider.authenticate !== 'function' || typeof provider.request !== 'function') {
      throw new TypeError('authentication provider must implement authenticate and request')
    }
    const registration: RegisteredProvider = { name, implementation: provider }

    return this.ctx.effect(() => {
      if (this.provider) throw new Error(`authentication provider "${this.provider.name}" is already registered`)
      this.provider = registration
      return () => {
        if (this.provider === registration) this.provider = undefined
      }
    }, `authentication.register(${JSON.stringify(name)})`)
  }

  /** Verify the server that sent one incoming protocol request. */
  async authenticate(request: Request): Promise<AuthenticatedServer> {
    if (!(request instanceof Request)) throw new AuthenticationError('INVALID_REQUEST', 'authentication failed')
    const provider = this.requireProvider()
    try {
      return normalizeServer(await provider.implementation.authenticate(request), provider.name)
    } catch (error) {
      if (error instanceof AuthenticationError) throw error
      throw new AuthenticationError('INVALID_CREDENTIAL', 'authentication failed', { cause: error })
    }
  }

  /** Send one outgoing request through the active authentication provider. */
  async request(
    target: Readonly<AuthenticationTarget>,
    request: Request,
    dispatch: AuthenticationDispatch = globalDispatch,
  ): Promise<Response> {
    const audience = requireText(target?.audience, 'authentication audience', 'INVALID_REQUEST')
    if (!(request instanceof Request) || typeof dispatch !== 'function') {
      throw new AuthenticationError('INVALID_REQUEST', 'authentication request is invalid')
    }
    const provider = this.requireProvider()
    try {
      const response = await provider.implementation.request({ audience }, request, dispatch)
      if (!(response instanceof Response)) throw new TypeError('authentication provider returned no response')
      return response
    } catch (error) {
      if (error instanceof AuthenticationError) throw error
      throw new AuthenticationError('TOKEN_REQUEST_FAILED', 'authenticated request failed', { cause: error })
    }
  }

  /** Bind trusted user context to the invocation authenticated as one server. */
  withUser<T>(
    user: Readonly<TrustedUserContext>,
    server: Readonly<AuthenticatedServer>,
    operation: () => T,
  ): T {
    if (typeof operation !== 'function') throw new TypeError('principal operation must be a function')
    const verifiedServer = normalizeServer(server, requireText(server?.provider, 'server authentication provider'))
    const principal = normalizeUser(user, verifiedServer)
    return this.invocationPrincipal.run(principal, operation)
  }

  /** Resolve the trusted user attached to the current invocation. */
  async currentPrincipal(): Promise<AuthenticatedIdentity> {
    const principal = this.invocationPrincipal.getStore()
    if (!principal) throw new AuthenticationError('NO_CURRENT_PRINCIPAL', 'authentication failed')
    return principal
  }

  /** Return the current user in the transport-neutral trusted-context shape. */
  async currentUser(): Promise<TrustedUserContext> {
    const principal = await this.currentPrincipal()
    return Object.freeze({
      tenantId: principal.tenantId,
      userId: principal.subject,
      claims: principal.claims,
    })
  }

  /** Describe the active provider without exposing its implementation. */
  currentProvider(): AuthenticationProviderDescriptor | undefined {
    return this.provider ? Object.freeze({ name: this.provider.name }) : undefined
  }

  private requireProvider(): RegisteredProvider {
    if (!this.provider) throw new AuthenticationError('NO_PROVIDER', 'authentication provider is unavailable')
    return this.provider
  }
}

/** Encode user context for a request that is independently server-authenticated. */
export function encodeTrustedUserContext(user: Readonly<TrustedUserContext>): string {
  const normalized = normalizeTrustedUser(user)
  return Buffer.from(JSON.stringify({ tenantId: normalized.tenantId, userId: normalized.userId }), 'utf8').toString('base64url')
}

/** Decode optional user context after the carrying server has been authenticated. */
export function decodeTrustedUserContext(value: string | null): TrustedUserContext | undefined {
  if (value === null) return
  if (!value || value.length > 16_384) throw new AuthenticationError('INVALID_IDENTITY', 'trusted user context is invalid')
  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown
    if (!isRecord(decoded) || Object.keys(decoded).some(key => key !== 'tenantId' && key !== 'userId')) {
      throw new TypeError('unexpected trusted user field')
    }
    return normalizeTrustedUser(decoded as unknown as TrustedUserContext)
  } catch (cause) {
    if (cause instanceof AuthenticationError) throw cause
    throw new AuthenticationError('INVALID_IDENTITY', 'trusted user context is invalid', { cause })
  }
}

function normalizeServer(server: AuthenticatedServer, provider: string): AuthenticatedServer {
  if (
    !server
    || typeof server !== 'object'
    || typeof server.id !== 'string'
    || !server.id.trim()
    || server.provider !== provider
    || !isRecord(server.claims)
  ) {
    throw new AuthenticationError('INVALID_IDENTITY', 'authentication provider returned an invalid server identity')
  }
  return Object.freeze({ id: server.id, provider, claims: Object.freeze({ ...server.claims }) })
}

function normalizeUser(user: Readonly<TrustedUserContext>, server: Readonly<AuthenticatedServer>): AuthenticatedIdentity {
  const trusted = normalizeTrustedUser(user)
  return Object.freeze({
    tenantId: trusted.tenantId,
    subject: trusted.userId,
    provider: `${server.provider}:${server.id}`,
    claims: trusted.claims ?? Object.freeze({}),
  })
}

function normalizeTrustedUser(user: Readonly<TrustedUserContext>): TrustedUserContext {
  if (!user || typeof user !== 'object' || (user.claims !== undefined && !isRecord(user.claims))) {
    throw new AuthenticationError('INVALID_IDENTITY', 'trusted user context is invalid')
  }
  return Object.freeze({
    tenantId: requireText(user.tenantId, 'tenant ID', 'INVALID_IDENTITY'),
    userId: requireText(user.userId, 'user ID', 'INVALID_IDENTITY'),
    ...(user.claims === undefined ? {} : { claims: Object.freeze({ ...user.claims }) }),
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function requireText(value: unknown, label: string, code?: AuthenticationErrorCode): string {
  if (typeof value === 'string' && value.trim()) return value
  const message = `${label} must be a non-empty string`
  if (code) throw new AuthenticationError(code, message)
  throw new TypeError(message)
}

function globalDispatch(request: Request) {
  return fetch(request)
}

export default AuthenticationService
