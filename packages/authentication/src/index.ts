import { Service, type Context } from '@karaka/cordis'

declare module '@karaka/cordis' {
  interface Context {
    authentication: AuthenticationService
  }
}

/** Input accepted by the authentication seam. Tenant routing is explicit. */
export interface AuthenticationRequest {
  tenantId: string
  token: string
}

/** Provider-neutral identity established by a successful authentication. */
export interface AuthenticatedIdentity {
  tenantId: string
  subject: string
  provider: string
  claims: Readonly<Record<string, unknown>>
}

/** One authentication implementation contributed by a Cordis plugin. */
export interface AuthenticationProvider {
  readonly name: string
  readonly tenantIds: readonly string[]
  authenticate(request: Readonly<AuthenticationRequest>): Promise<AuthenticatedIdentity>
}

/** Once-mounted resolver for the principal active in the current invocation. */
export interface CurrentPrincipalResolver {
  readonly name: string
  currentPrincipal(): AuthenticatedIdentity | null | undefined | Promise<AuthenticatedIdentity | null | undefined>
}

/** Stable authentication failures consumers may handle without provider coupling. */
export type AuthenticationErrorCode =
  | 'INVALID_REQUEST'
  | 'UNKNOWN_TENANT'
  | 'NO_CURRENT_PRINCIPAL'
  | 'INVALID_TOKEN'
  | 'INVALID_IDENTITY'

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

/** Read-only description of one active provider registration. */
export interface AuthenticationProviderDescriptor {
  name: string
  tenantIds: readonly string[]
}

interface RegisteredProvider extends AuthenticationProviderDescriptor {
  implementation: AuthenticationProvider
}

interface RegisteredPrincipalResolver {
  readonly name: string
  readonly implementation: CurrentPrincipalResolver
  calls: number
  active: boolean
  resolveDrained?: () => void
}

/**
 * Authentication service and tenant router.
 *
 * Provider plugins register implementations through {@link register}. The
 * registration effect belongs to the calling plugin and disappears with it.
 */
export class AuthenticationService extends Service {
  private readonly providers = new Map<string, RegisteredProvider>()
  private readonly tenantProviders = new Map<string, RegisteredProvider>()
  private principalResolver: RegisteredPrincipalResolver | undefined

  constructor(ctx: Context) {
    super(ctx, 'authentication')
  }

  /** Register a provider for its declared tenants until the caller unloads. */
  register(provider: AuthenticationProvider) {
    const name = requireText(provider.name, 'provider name')
    const tenantIds = [...new Set(provider.tenantIds.map(tenantId => requireText(tenantId, 'tenant ID')))]
    if (!tenantIds.length) throw new Error(`authentication provider "${name}" must declare at least one tenant`)
    const registration: RegisteredProvider = {
      name,
      tenantIds: Object.freeze(tenantIds),
      implementation: provider,
    }

    return this.ctx.effect(() => {
      if (this.providers.has(name)) {
        throw new Error(`authentication provider "${name}" is already registered`)
      }
      for (const tenantId of tenantIds) {
        const current = this.tenantProviders.get(tenantId)
        if (current) {
          throw new Error(`authentication tenant "${tenantId}" is already handled by provider "${current.name}"`)
        }
      }

      this.providers.set(name, registration)
      for (const tenantId of tenantIds) this.tenantProviders.set(tenantId, registration)

      return () => {
        this.providers.delete(name)
        for (const tenantId of tenantIds) {
          if (this.tenantProviders.get(tenantId) === registration) this.tenantProviders.delete(tenantId)
        }
      }
    }, `authentication.register(${JSON.stringify(name)})`)
  }

  /** Register the current-principal resolver until its plugin unloads. */
  registerCurrentPrincipal(resolver: CurrentPrincipalResolver) {
    const name = requireText(resolver.name, 'principal resolver name')
    if (typeof resolver.currentPrincipal !== 'function') {
      throw new TypeError('currentPrincipal must be a function')
    }
    const registration: RegisteredPrincipalResolver = {
      name,
      implementation: resolver,
      calls: 0,
      active: true,
    }

    return this.ctx.effect(() => {
      if (this.principalResolver) {
        throw new Error(`current principal resolver "${this.principalResolver.name}" is already registered`)
      }
      this.principalResolver = registration

      return async () => {
        if (this.principalResolver === registration) this.principalResolver = undefined
        registration.active = false
        if (registration.calls) {
          await new Promise<void>(resolve => {
            registration.resolveDrained = resolve
          })
        }
      }
    }, `authentication.registerCurrentPrincipal(${JSON.stringify(name)})`)
  }

  /** Resolve the principal attached to the caller's current invocation. */
  async currentPrincipal(): Promise<AuthenticatedIdentity> {
    const registration = this.principalResolver
    if (!registration) throw noCurrentPrincipal()
    registration.calls++

    try {
      let identity: AuthenticatedIdentity | null | undefined
      try {
        identity = await registration.implementation.currentPrincipal()
      } catch (error) {
        if (error instanceof AuthenticationError) throw error
        throw new AuthenticationError('INVALID_IDENTITY', 'authentication failed', { cause: error })
      }
      if (identity == null) throw noCurrentPrincipal()
      return normalizeIdentity(identity, registration.name)
    } finally {
      registration.calls--
      if (!registration.active && !registration.calls) registration.resolveDrained?.()
    }
  }

  /** Authenticate a token through the provider registered for its tenant. */
  async authenticate(request: Readonly<AuthenticationRequest>) {
    const tenantId = requireText(request?.tenantId, 'tenant ID', 'INVALID_REQUEST')
    const token = requireText(request?.token, 'token', 'INVALID_REQUEST')
    const registration = this.tenantProviders.get(tenantId)
    if (!registration) {
      throw new AuthenticationError('UNKNOWN_TENANT', 'authentication failed')
    }

    let identity: AuthenticatedIdentity
    try {
      identity = await registration.implementation.authenticate({ tenantId, token })
    } catch (error) {
      if (error instanceof AuthenticationError) throw error
      throw new AuthenticationError('INVALID_TOKEN', 'authentication failed', { cause: error })
    }

    return normalizeIdentity(identity, registration.name, tenantId)
  }

  /** List active providers without exposing their implementations. */
  list(): readonly AuthenticationProviderDescriptor[] {
    return [...this.providers.values()].map(registration => Object.freeze({
      name: registration.name,
      tenantIds: registration.tenantIds,
    }))
  }
}

function normalizeIdentity(
  identity: AuthenticatedIdentity,
  provider: string,
  tenantId?: string,
): AuthenticatedIdentity {
  if (
    !identity
    || typeof identity !== 'object'
    || (tenantId !== undefined && identity.tenantId !== tenantId)
    || typeof identity.tenantId !== 'string'
    || !identity.tenantId.trim()
    || typeof identity.subject !== 'string'
    || !identity.subject.trim()
    || identity.provider !== provider
    || !identity.claims
    || typeof identity.claims !== 'object'
    || Array.isArray(identity.claims)
  ) {
    throw new AuthenticationError('INVALID_IDENTITY', 'authentication provider returned an invalid identity')
  }
  return Object.freeze({
    tenantId: identity.tenantId,
    subject: identity.subject,
    provider: identity.provider,
    claims: Object.freeze({ ...identity.claims }),
  })
}

function noCurrentPrincipal() {
  return new AuthenticationError('NO_CURRENT_PRINCIPAL', 'authentication failed')
}

function requireText(value: unknown, label: string, code?: AuthenticationErrorCode): string {
  if (typeof value === 'string' && value.trim()) return value
  const message = `${label} must be a non-empty string`
  if (code) throw new AuthenticationError(code, message)
  throw new TypeError(message)
}

export default AuthenticationService
