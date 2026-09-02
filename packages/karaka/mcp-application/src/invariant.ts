/** Runtime invariant registration for authenticated application MCP endpoints. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

export const name = 'karaka-mcp-application-invariant'
export const inject = ['invariants']

/** No runtime invariant: endpoint identity is checked during presentation and invocation. */
const install: InvariantInstaller = () => {}

export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register('@karaka-ai/mcp-application', install))
