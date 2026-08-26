/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-identity-http-bearer`.
 * @module @deepseek-ai/dsh-identity-http-bearer/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-identity-http-bearer'

/** Cordis companion plugin name. */
export const name = 'identity-http-bearer-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** No runtime invariant: parsing and delegation are checked by the Consumer boundary. */
const install: InvariantInstaller = () => {}

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
