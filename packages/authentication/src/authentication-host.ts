import type { Context } from '@karaka/cordis'
import Schema from '@karaka/schemastery'
import type { AuthenticatedIdentity } from './index.ts'

/** YAML-serializable identity asserted by a trusted embedding application. */
export interface Config {
  tenantId: string
  subject: string
  claims?: Record<string, unknown>
}

export const Config: Schema<Config> = Schema.object({
  tenantId: Schema.string().required(),
  subject: Schema.string().required(),
  claims: Schema.dict(Schema.any()).default({}),
})

/**
 * Establish an identity already authenticated by the embedding host.
 *
 * Mount this plugin below an isolated `identity` context whenever more than
 * one caller may be active in the same process.
 */
export const plugin = {
  name: 'authentication-host',
  provide: 'identity',
  Config,
  apply(ctx: Context, config: Config) {
    const identity: AuthenticatedIdentity = Object.freeze({
      tenantId: requireText(config.tenantId, 'tenant ID'),
      subject: requireText(config.subject, 'subject'),
      provider: 'host',
      claims: Object.freeze({ ...config.claims }),
    })
    ctx.provide('identity', identity)
  },
}

function requireText(value: unknown, label: string): string {
  if (typeof value === 'string' && value.trim()) return value
  throw new TypeError(`${label} must be a non-empty string`)
}

export default plugin
