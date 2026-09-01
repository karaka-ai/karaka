/** Package-owned invariant companion for `@karaka/cli`. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@karaka/cli'

export const name = 'karaka-cli-invariant'
export const inject = ['invariants']

/** No runtime invariant: the CLI owns a child process, not Cordis runtime state. */
const install: InvariantInstaller = () => {}

export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
