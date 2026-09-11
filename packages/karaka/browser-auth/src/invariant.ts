/** Runtime invariant registration for Karaka browser authentication. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

export const name = 'karaka-browser-auth-invariant'
export const inject = ['invariants']

/** No runtime invariant: each credential is resolved and checked at its request boundary. */
const install: InvariantInstaller = () => {}

export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register('@karaka-ai/browser-auth', install))
