/** Scoped policy state shared by the registrar and Karaka's preset adapter. */
import type { Context } from '@deepseek-ai/cordis'
import { scopeChainOf, scopeOf } from '@deepseek-ai/dsh-scope'
import type { Agent } from '@deepseek-ai/dsh-agent'

/** Public-name restrictions contributed by one Agent preset. */
export interface ToolPolicy {
  /** Explicit allowed names; every supplied ancestor list must admit the tool. */
  readonly allow?: readonly string[]
  /** Names denied regardless of allow lists in this or descendant scopes. */
  readonly deny?: readonly string[]
}
const policies = new WeakMap<object, Set<ToolPolicy>>()
const listeners = new WeakMap<object, Set<() => void>>()
const catalogs = new WeakMap<object, Map<string, number>>()

/**
 * Record one application catalog contribution; repeated names are reference-counted.
 * @param ctx - Context identifying the owning root.
 * @param name - Public application tool name.
 * @returns Disposer for this contribution.
 */
export function registerCatalog(ctx: Context, name: string): () => void {
  let catalog = catalogs.get(ctx.root)
  if (catalog === undefined) catalogs.set(ctx.root, catalog = new Map<string, number>())
  catalog.set(name, (catalog.get(name) ?? 0) + 1)
  const contributions = catalog
  return () => {
    const count = (contributions.get(name) as number) - 1
    if (count === 0) contributions.delete(name)
    else contributions.set(name, count)
  }
}
/**
 * Read application tool names in one root without exposing the mutable catalog.
 * @param ctx - Context identifying the owning root.
 * @returns A detached set of currently contributed names.
 */
export function applicationToolNames(ctx: Context): ReadonlySet<string> {
  return new Set(catalogs.get(ctx.root)?.keys())
}
/**
 * Require an explicit allow and respect every restriction in the Agent scope chain.
 * @param agent - Agent used as the registration scope identity.
 * @param name - Public tool name to authorize.
 * @returns Whether at least one allow list admits the name and no scoped policy rejects it.
 */
export function policyAllows(agent: Agent, name: string): boolean {
  let explicitlyAllowed = false
  for (const scope of scopeChainOf(agent)) {
    for (const policy of policies.get(scope) ?? []) {
      if (policy.allow !== undefined) {
        if (!policy.allow.includes(name)) return false
        explicitlyAllowed = true
      }
      if (policy.deny?.includes(name)) return false
    }
  }
  return explicitlyAllowed
}
/**
 * Subscribe to synchronous policy changes in one root.
 * @param ctx - Context identifying the owning root.
 * @param listener - Callback invoked when a policy is added or removed.
 * @returns Disposer that stops notifications.
 */
export function watchPolicy(ctx: Context, listener: () => void): () => void {
  let set = listeners.get(ctx.root)
  if (set === undefined) listeners.set(ctx.root, set = new Set())
  set.add(listener)
  return () => { set.delete(listener) }
}
/**
 * Contribute a policy in an Agent scope; unscoped contexts are rejected.
 * @param ctx - Context tagged with the Agent registration scope.
 * @param policy - Allow and deny restrictions for that scope.
 * @returns Disposer that removes the restriction and notifies observers.
 */
export function registerPolicy(ctx: Context, policy: ToolPolicy): () => void {
  const scope = scopeOf(ctx)
  if (scope === undefined) throw new Error('Karaka tool policy must be mounted inside an Agent preset')
  let set = policies.get(scope)
  if (set === undefined) policies.set(scope, set = new Set())
  set.add(policy)
  const notify = () => { for (const listener of listeners.get(ctx.root) ?? []) listener() }
  try { notify() } catch (error) { set.delete(policy); throw error }
  return () => { set.delete(policy); notify() }
}
