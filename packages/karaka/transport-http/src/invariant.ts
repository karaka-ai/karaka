import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

export const name = 'karaka-transport-http-invariant'
export const inject = ['invariants']

/** No runtime invariant: request validation and ownership checks occur at ingress. */
const install: InvariantInstaller = () => {}

export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register('@karaka/transport-http', install))
