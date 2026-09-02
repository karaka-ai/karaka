/** Runtime invariant registration for Karaka server authentication. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

export const name = 'karaka-server-auth-invariant'
export const inject = ['invariants']

/** No runtime invariant: each credential is resolved and checked at its request boundary. */
const install: InvariantInstaller = () => {}

export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register('@karaka-ai/server-auth', install))
