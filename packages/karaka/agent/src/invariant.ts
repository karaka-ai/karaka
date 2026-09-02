import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

export const name = 'karaka-agent-invariant'
export const inject = ['invariants']

/** No runtime invariant: the bundle composes packages that own their relations. */
const install: InvariantInstaller = () => {}

export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register('@karaka-ai/agent', install))
