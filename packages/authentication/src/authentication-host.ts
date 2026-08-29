import type { Context, Plugin } from '@karaka/cordis'
import Schema from '@karaka/schemastery'
import type { AuthenticatedIdentity } from './index.ts'

/** YAML-serializable identity asserted by a trusted embedding application. */
export interface Config {
  tenantId: string
  subject: string
  claims?: Record<string, unknown>
}

/** Principal supplied by trusted request-local host state. */
export interface HostPrincipal {
  readonly tenantId: string
  readonly subject: string
  readonly claims?: Readonly<Record<string, unknown>>
}

/** Programmatic adapter for a shared-process embedding host. */
export interface HostAuthenticationOptions {
  currentPrincipal(): HostPrincipal | null | undefined | Promise<HostPrincipal | null | undefined>
}

export const Config: Schema<Config> = Schema.object({
  tenantId: Schema.string().required(),
  subject: Schema.string().required(),
  claims: Schema.dict(Schema.any()).default({}),
})

/** Resolve one static, trusted identity for local development. */
export const plugin = {
  name: 'authentication-host',
  inject: ['authentication'],
  Config,
  apply(ctx: Context, config: Config) {
    const principal = createIdentity(config)
    registerHostResolver(ctx, () => principal)
  },
}

/** Create a once-mounted plugin backed by the host's request-local state. */
export function authenticationHost(options: HostAuthenticationOptions): Plugin.Object<void> {
  if (typeof options?.currentPrincipal !== 'function') {
    throw new TypeError('currentPrincipal must be a function')
  }
  return {
    name: 'authentication-host',
    inject: ['authentication'],
    apply(ctx: Context) {
      registerHostResolver(ctx, async () => {
        const principal = await options.currentPrincipal()
        return principal == null ? undefined : createIdentity(principal)
      })
    },
  }
}

function registerHostResolver(
  ctx: Context,
  currentPrincipal: () => AuthenticatedIdentity | undefined | Promise<AuthenticatedIdentity | undefined>,
) {
  ctx.authentication.registerCurrentPrincipal({ name: 'host', currentPrincipal })
}

function createIdentity(principal: HostPrincipal): AuthenticatedIdentity {
  const claims = principal.claims ?? {}
  if (!claims || typeof claims !== 'object' || Array.isArray(claims)) {
    throw new TypeError('claims must be an object')
  }
  return Object.freeze({
    tenantId: requireText(principal.tenantId, 'tenant ID'),
    subject: requireText(principal.subject, 'subject'),
    provider: 'host',
    claims: Object.freeze({ ...claims }),
  })
}

function requireText(value: unknown, label: string): string {
  if (typeof value === 'string' && value.trim()) return value
  throw new TypeError(`${label} must be a non-empty string`)
}

export default plugin
