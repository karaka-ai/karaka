/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-experimental-code-runtime-python`.
 * @module @deepseek-ai/dsh-experimental-code-runtime-python/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-experimental-code-runtime-python'

/** Cordis companion plugin name. */
export const name = 'code-runtime-python-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: every relation this backend maintains — frame ordering, budget accounting,
 * and process teardown — lives in the CPython subprocess or on the fd-3 wire, so no same-process
 * event sequence or mutable data relation is observable from a Cordis listener. `protocol.spec.ts`,
 * `protocol-mirror.e2e.ts`, and the real-subprocess `runtime.spec.ts` cover that behavior, matching
 * the sibling process-boundary backend `@deepseek-ai/dsh-code-runtime-worker-thread`.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
