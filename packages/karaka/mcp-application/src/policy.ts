/** Scoped policy state shared by the registrar and Karaka's preset adapter. */
import type { Context } from '@deepseek-ai/cordis'
import { scopeChainOf, scopeOf } from '@deepseek-ai/dsh-scope'
import type { Agent } from '@deepseek-ai/dsh-agent'

export interface ToolPolicy { readonly allow?: readonly string[]; readonly deny?: readonly string[] }
const policies = new WeakMap<object, Set<ToolPolicy>>()
const listeners = new WeakMap<object, Set<() => void>>()
const catalogs = new WeakMap<object, Map<string, number>>()

export function registerCatalog(ctx: Context, name: string): () => void {
  let catalog = catalogs.get(ctx.root)
  if (catalog === undefined) catalogs.set(ctx.root, catalog = new Map())
  catalog.set(name, (catalog.get(name) ?? 0) + 1)
  return () => {
    const count = catalog!.get(name)! - 1
    if (count === 0) catalog!.delete(name)
    else catalog!.set(name, count)
  }
}
export function applicationToolNames(ctx: Context): ReadonlySet<string> {
  return new Set(catalogs.get(ctx.root)?.keys())
}
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
export function watchPolicy(ctx: Context, listener: () => void): () => void {
  let set = listeners.get(ctx.root)
  if (set === undefined) listeners.set(ctx.root, set = new Set())
  set.add(listener)
  return () => { set!.delete(listener) }
}
export function registerPolicy(ctx: Context, policy: ToolPolicy): () => void {
  const scope = scopeOf(ctx)
  if (scope === undefined) throw new Error('Karaka tool policy must be mounted inside an Agent preset')
  let set = policies.get(scope)
  if (set === undefined) policies.set(scope, set = new Set())
  set.add(policy)
  const notify = () => { for (const listener of listeners.get(ctx.root) ?? []) listener() }
  try { notify() } catch (error) { set.delete(policy); throw error }
  return () => { set!.delete(policy); notify() }
}
