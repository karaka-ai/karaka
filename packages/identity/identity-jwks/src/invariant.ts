/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-identity-jwks`.
 * @module @deepseek-ai/dsh-identity-jwks/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-identity-jwks'

/** Cordis companion plugin name. */
export const name = 'identity-jwks-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** No runtime invariant: provider verification is checked at its asynchronous request boundary. */
const install: InvariantInstaller = () => {}

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
