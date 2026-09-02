/** Package-owned invariant companion for `@karaka-ai/sdk`. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@karaka-ai/sdk'

export const name = 'karaka-sdk-invariant'
export const inject = ['invariants']

/** No runtime invariant: callers own SDK clients and tool hosts outside Cordis. */
const install: InvariantInstaller = () => {}

export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
