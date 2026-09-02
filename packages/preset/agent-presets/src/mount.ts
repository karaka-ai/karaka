/**
 * Mount one preset composition under its standing scope, then prove the result
 * is usable before any agent joins that generation.
 *
 * Entry contexts chain to the standing context, so scoped contributions remain
 * visible to every agent joined to that preset while the mounted generation
 * lives. Two guards make that safe. A row that never reached a usable state is
 * rejected, because a directly-plugged subtree is absent from
 * `ctx.loader.entries()` and no boot audit covers it. A row that published a
 * service into the ROOT realm is rejected because it escaped preset isolation.
 * @module @deepseek-ai/dsh-agent-presets/mount
 */

import { pathToFileURL } from 'node:url'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import { Include } from '@deepseek-ai/cordis-plugin-include'
import type { EntryTree } from '@deepseek-ai/cordis-plugin-loader'
import { scopeOf, scopeParentOf, type ScopeKey } from '@deepseek-ai/dsh-scope'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { AgentPreset } from './preset.ts'
import { classifyRowSpecifier } from './specifier.ts'

/** What one mounted subtree publishes about itself for the audit to read. */
interface MountedTree {
  /** The rows the composition created. */
  readonly tree: EntryTree
  /**
   * The subtree's own fiber. Captured here rather than taken from
   * `ctx.plugin()`, which hands back a thenable `Object.create(fiber)` wrapper
   * that is never identical to the fiber appearing in a parent chain.
   */
  readonly fiber: Fiber
}

/**
 * Subtrees captured by config identity. A subtree plugged directly (rather than
 * created as a loader entry) never links itself to an `Entry`, so this is the
 * only handle to the rows it created; config objects are minted per mount, so
 * concurrent mounts cannot collide.
 */
const mounted = new WeakMap<object, MountedTree>()

/**
 * The base URL bare specifiers resolve against, per pending mount, keyed by the
 * same config object. Recorded before the subtree is plugged, because `Include`
 * rewrites its own context's `baseUrl` to the composition's directory and the
 * pre-mount value is the only handle on the host-selected package base.
 */
const barePackageBase = new WeakMap<object, string>()

/**
 * Include subclass that publishes its tree and fiber for the audit, and never
 * writes to the file it read.
 */
class PresetTree extends Include {
  constructor(ctx: Context, config: Include.Config) {
    super(ctx, config)
    // EntryTree's constructor files every new tree under the nearest owning
    // Loader entry's `subtree` slot — here the roster's own row, because the
    // standing scope descends from the roster's fiber. Left in place, root
    // `loader.entries()` would walk this composition as host entries (each
    // preset overwriting the last), against the standing mount's contract of
    // not being a Loader entry. Reclaim the slot.
    const owner = this.ctx.fiber.entry
    if (owner?.subtree === this) delete owner.subtree
    mounted.set(config, { tree: this, fiber: ctx.fiber })
  }

  /**
   * Resolve a bare specifier from the host-selected base rather than from the preset.
   *
   * `EntryTree.import()` resolves against the tree's own `baseUrl`, which
   * `Include` sets to the composition's directory. That is right for a
   * relative specifier — a preset's own files travel with it — and wrong for
   * a package name: a locally authored preset lives under the user's home,
   * where Node's upward `node_modules` walk never reaches the harness's own
   * dependencies, so every package row would fail to import. The mount records
   * the host-selected base instead, and bare names resolve from there. An absolute
   * filesystem path names neither base and becomes a file URL before Node's
   * ESM loader receives it, which is required for drive-letter paths on
   * Windows.
   *
   * {@link classifyRowSpecifier} makes that split, so discovery's health check
   * resolves every row from the same base this import uses.
   * @param name - the module specifier from the row.
   * @param getOuterStack - the loader's stack composer for import diagnostics.
   * @returns the imported module, or the `cordis:` builtin.
   */
  override import(name: string, getOuterStack?: () => string[]): unknown {
    const bundled: unknown = this.ctx.loader.builtins[name]
    if (bundled !== undefined) return bundled
    const row = classifyRowSpecifier(name)
    const base = barePackageBase.get(this.config)
    /* v8 ignore next -- every PresetTree is constructed by `mountPreset`, which records the base first */
    if (base === undefined) return super.import(row.specifier, getOuterStack)
    if (row.kind === 'builtin' || row.kind === 'preset') return super.import(row.specifier, getOuterStack)
    const internal = this.ctx.loader.internal
    /* v8 ignore next -- Node always supplies the internal module loader; the branch keeps a
       hypothetical embedder from losing the row's name in a resolution error. */
    if (internal === undefined) return super.import(row.specifier, getOuterStack)
    return internal.import(row.specifier, base, {})
  }

  /**
   * A preset is an input, never a persistence target.
   *
   * The Loader writes a tree back through this method whenever it decides the
   * config changed — a plugin self-disposing is enough, and tearing an agent
   * down disposes its whole subtree. Inherited, that rewrites the preset file
   * with whatever the dying tree held, which in practice means truncating a
   * shipped composition to `[]` the first time a session ends. Persisting a
   * preset is also meaningless: nothing here is user state, and the same file
   * backs every session that names it.
   *
   * Dropping the write drops the `loader/config-update` the inherited method
   * emits with it. No consumer observes one for a preset subtree, and a
   * future "edit your preset while it runs" flow needs a deliberate
   * persistence path rather than this method's return.
   */
  override write(): void {
  }
}

/** One preset composition currently installed under some agent. */
export interface PresetMount {
  /** The preset the subtree was composed from. */
  readonly presetId: string
  /** The mounted subtree's fiber. */
  readonly fiber: Fiber
  /** Loader entry tree whose active rows form this standing composition. */
  readonly tree: EntryTree
  /** The standing scope key agents are parented to (undefined only in torn-down records). */
  readonly key: ScopeKey | undefined
}

const mounts = new Set<PresetMount>()

/**
 * Drop every record whose subtree is gone.
 *
 * Records are pruned by observation rather than through a disposal hook
 * because a subtree can be torn down by its owning agent, by a failed mount, or
 * by the whole tree unloading, and a cleared `uid` is what all three share.
 *
 * Pruning therefore has to happen on a path this module owns. Reading is one
 * such path, but not a reliable one: the only production reader is the
 * invariant companion's service listener, and `dsh-invariants` is a
 * development composition — a shipped host never loads it. Mounting is the
 * other, and it is the one every session takes, which bounds the set at one
 * generation of dead records rather than one per session ever composed. Each
 * record would otherwise retain its whole disposed subtree: the fiber holds
 * its config, and that config is the key its `EntryTree` is stored under.
 */
function pruneDisposedMounts(): void {
  for (const mount of mounts) {
    if (mount.fiber.uid === null) mounts.delete(mount)
  }
}

/**
 * Every preset composition still installed, pruning fibers disposed since the
 * last read.
 *
 * The record set is module state and therefore spans every Cordis runtime in
 * the process; a reader that serves one runtime passes that runtime's root
 * fiber so another runtime mounting the same preset id (a second embedded
 * app, a test's second harness) never answers for it.
 * @param within - when present, only mounts inside this fiber's subtree.
 * @returns the live mounts.
 */
export function livePresetMounts(within?: Fiber): PresetMount[] {
  pruneDisposedMounts()
  const all = [...mounts]
  return within === undefined ? all : all.filter(mount => withinFiber(mount.fiber, within))
}

/**
 * Whether `fiber` is `root` itself or is mounted anywhere inside its subtree.
 *
 * Membership is object identity. `uid` looks like a cheaper key but is a
 * per-registry counter, so fibers in two different roots collide on it and a
 * subtree in one runtime would be blamed for a service published in another.
 * @param fiber - the fiber to locate.
 * @param root - the subtree root to test membership against.
 * @returns true when `fiber` belongs to `root`'s subtree.
 */
function withinFiber(fiber: Fiber, root: Fiber): boolean {
  let current = fiber
  while (true) {
    if (current === root) return true
    const parent = current.parent.fiber
    if (parent === current) return false
    current = parent
  }
}

/**
 * Service names the mounted subtree published into the root realm.
 *
 * A provider without an `isolate` realm stores its implementation under the
 * root's symbol for that name, which is exactly the comparison below; a
 * provider inside an `isolate` realm stores under a realm-private symbol and
 * is correctly absent here.
 * @param ctx - any context of the runtime whose service store is inspected.
 * @param mount - the mounted subtree's fiber.
 * @returns the leaked service names in lexical order.
 */
export function leakedServices(ctx: Context, mount: Fiber): string[] {
  const store = ctx.reflect.store
  const rootIsolate = ctx.root[Context.isolate]
  const leaked: string[] = []
  for (const key of Object.getOwnPropertySymbols(store)) {
    const impl = store[key]
    /* v8 ignore next -- cordis deletes a store slot on disposal rather than
       clearing it, so an own symbol always resolves; the guard exists only
       because the store's index signature is optional. */
    if (impl === undefined) continue
    if (!withinFiber(impl.fiber, mount)) continue
    if (rootIsolate[impl.name] === key) leaked.push(impl.name)
  }
  return leaked.sort((left, right) => left.localeCompare(right))
}

/** A live standing mount located through one agent already joined to it. */
export type JoinedPresetMount = PresetMount & {
  /** The standing key, definite because it is what the lookup matched on. */
  readonly key: ScopeKey
}

/**
 * The standing composition one agent is joined to.
 *
 * The agent's own key is parented to its preset's standing key, so the mount
 * is found by matching that parent rather than by walking up from the agent —
 * the mount is not under the agent's fiber. An agent that joined no preset —
 * a deployment composing no roster, or a child agent before its join — has no
 * parent link and resolves to undefined.
 * @param agentCtx - the agent's scope context.
 * @returns the mount the agent joined, or undefined when it joined none.
 */
export function standingMountFor(agentCtx: Context): JoinedPresetMount | undefined {
  const agentKey = scopeOf(agentCtx)
  if (agentKey === undefined) return undefined
  const standingKey = scopeParentOf(agentKey)
  if (standingKey === undefined) return undefined
  return livePresetMounts().find(
    (candidate): candidate is JoinedPresetMount => candidate.key === standingKey,
  )
}

/**
 * The shared service instance mounted by an agent's preset generation.
 *
 * Agents joined to one standing generation resolve the same instance. Its
 * `isolate` realm separates that generation from the root and other preset
 * generations, while making it invisible to the host. The agent is therefore
 * an address for locating the generation, not an owner of a chat-local service
 * instance. Every browser RPC the api-proxy serves needs this addressing
 * because it arrives from outside the preset realm.
 *
 * Ownership is the same relation {@link leakedServices} reads, inverted: there
 * it names implementations a subtree published into the ROOT realm, here it
 * names the one this subtree published anywhere. Fiber membership is object
 * identity for the reason stated on {@link withinFiber}.
 *
 * This is READ addressing for a caller that already holds the agent. It is not
 * a general host handle on chat-local state: plugins keep that state on the
 * Agent or Session, or key it by their identities. A host row that `inject`s a
 * service cannot use this lookup because injection resolves without an agent;
 * such a service belongs on the host plane.
 * @param ctx - any context of the runtime whose service store is inspected.
 * @param agent - an agent joined to the preset generation to inspect.
 * @param name - the service name as the preset's rows resolve it.
 * @returns the generation's shared instance, or undefined when it mounts none.
 */
export function serviceForAgent<K extends string & keyof Context>(
  ctx: Context,
  agent: { ctx: Context },
  name: K,
): Context[K] | undefined {
  const mount = standingMountFor(agent.ctx)
  if (mount === undefined) return undefined
  const store = ctx.reflect.store
  for (const key of Object.getOwnPropertySymbols(store)) {
    const impl = store[key]
    /* v8 ignore next -- cordis deletes a store slot on disposal rather than clearing it */
    if (impl === undefined) continue
    if (impl.name !== name) continue
    if (withinFiber(impl.fiber, mount.fiber)) return impl.value as Context[K]
  }
  return undefined
}

/**
 * Rows that did not reach a usable state, each rendered as one diagnostic line.
 *
 * A row whose module failed to import or whose plugin threw already rejects the
 * mount through the loader; what remains observable here is a row still waiting
 * for a service the composition never supplies.
 * @param tree - the mounted subtree.
 * @returns one line per unusable row, empty when every enabled row is usable.
 */
export function inactiveRows(tree: EntryTree): string[] {
  const lines: string[] = []
  for (const entry of tree.entries()) {
    if (entry.disabled) continue
    const fiber = entry.fiber
    /* v8 ignore next 4 -- the loader rejects an entry whose module or plugin failed,
       so a settled tree never holds an enabled fiber-less entry; the branch exists
       only because `Entry.fiber` is declared optional. */
    if (fiber === undefined) {
      lines.push(`${entry.options.id} (${entry.options.name}): never started`)
      continue
    }
    const missing = Object.keys(fiber.inject).filter(name => fiber.ctx.get(name) === undefined)
    if (missing.length > 0) {
      lines.push(`${entry.options.id} (${entry.options.name}): waiting for ${missing.join(', ')}`)
    }
  }
  return lines
}

/**
 * The causes of `error` whose detail its own message does not already carry.
 *
 * `AggregateError` names none of its causes in its own message, so its
 * `errors` are the branches. The Loader's per-row wrapper takes the opposite
 * approach: it appends `cause.message` to the message it builds and keeps the
 * cause only as `error.cause`, so following a plain chain would print every
 * line twice. That leaves exactly one lossy shape — a wrapped row whose cause
 * is an `AggregateError`. Its message ends with the aggregate's own line and
 * drops the `errors` behind it, which is how a failed group reports as
 * "loader entries failed to apply" and names none of the rows that failed.
 * @param error - the failure to read branches from.
 * @returns the branches to render beneath `error.message`, possibly empty.
 */
function detailBranches(error: Error): readonly unknown[] {
  if (error instanceof AggregateError) return error.errors
  return error.cause instanceof AggregateError ? error.cause.errors : []
}

/**
 * The reportable text of a mount failure.
 *
 * The loader reports several failed rows as one `AggregateError`, whose own
 * message names none of them; without flattening, a composition that fails on
 * two rows says only "loader entries failed to apply" and the operator has
 * nothing to act on. Nested groups indent under the row that owns them, so a
 * composition failing inside a group still names the rows rather than the
 * group alone.
 * @param error - the value the mount rejected with.
 * @returns a single-line-per-cause description.
 */
function mountDetail(error: unknown): string {
  /* v8 ignore next -- every path into the mount's catch throws an Error: the loader
     wraps a row's thrown value before it propagates, and this module's own
     rejections are Errors. The fallback keeps a hostile value readable. */
  if (!(error instanceof Error)) return String(error)
  const branches = detailBranches(error)
  if (branches.length === 0) return error.message
  return [
    error.message,
    ...branches.map(branch => `- ${mountDetail(branch).replaceAll('\n', '\n  ')}`),
  ].join('\n')
}

/**
 * Mount `preset` under `standingCtx` and return only once every row is usable.
 *
 * The subtree is owned by the standing generation's fiber, so it is shared by
 * joined agents and unwinds when that generation is disposed. A rejection
 * leaves nothing mounted.
 * @param standingCtx - the standing preset generation's scope context.
 * @param preset - the resolved preset to compose the agent from.
 * @throws when `standingCtx` carries no scope, a row is unusable, or a row
 * published a service into the root realm.
 */
export async function mountPreset(standingCtx: Context, preset: AgentPreset): Promise<void> {
  const scope = scopeOf(standingCtx)
  if (scope === undefined) {
    throw new Error(
      `agent-presets: refusing to mount preset "${preset.id}" into an unscoped context; `
      + 'its registrations would apply to every agent in the process',
    )
  }
  const config: Include.Config = { path: pathToFileURL(preset.path).href }
  // Captured before the subtree exists: the standing scope context still
  // carries the host-selected package base, which is where a row's bare
  // package name has to resolve from.
  /* v8 ignore next -- the Loader sets `baseUrl` on the root before any scoped context derives from it */
  const bareModuleBaseUrl = standingCtx.get('loaderBareModuleBaseUrl') ?? standingCtx.baseUrl
  if (bareModuleBaseUrl !== undefined) barePackageBase.set(config, bareModuleBaseUrl)
  // Before the record this mount is about to add: standing mounts are one per
  // preset and live until whole-tree teardown, so pruning here only sweeps
  // records of torn-down runtimes (tests; an HMR reload of the roster).
  pruneDisposedMounts()
  const handle = standingCtx.plugin(PresetTree, config)
  try {
    await handle.await()
    const subtree = mounted.get(config)
    /* v8 ignore next -- the subclass constructor runs before `await()` settles for every mounted tree */
    if (subtree === undefined) throw new Error('mounted subtree did not publish its entry tree')
    const { tree, fiber } = subtree
    const unusable = inactiveRows(tree)
    if (unusable.length > 0) {
      throw new Error(`${String(unusable.length)} row(s) did not activate:\n${unusable.join('\n')}`)
    }
    const leaked = leakedServices(standingCtx, fiber)
    if (leaked.length > 0) {
      throw new Error(
        `row(s) published process-global service(s) [${leaked.join(', ')}]; `
        + 'a preset service must sit behind an `isolate` realm or move to the host composition',
      )
    }
    mounts.add({ presetId: preset.id, fiber, tree, key: scopeOf(standingCtx) })
  } catch (error) {
    try {
      await handle.dispose()
    /* v8 ignore next 5 -- teardown of a subtree nothing else references has no
       observed failure mode; the guard exists so a teardown error cannot
       replace the mount diagnostic the caller needs. */
    } catch {
      // Swallows only this subtree's teardown failure. The mount error below is
      // the actionable one, and the discarded fiber is unreachable either way.
    }
    const reason = `${mountDetail(error)} (${preset.path})`
    throw new RemoteError(
      'agent-preset/invalid',
      `agent-presets: preset "${preset.id}" failed to mount: ${reason}`,
      { agentPreset: preset.id, reason },
      { cause: error },
    )
  }
}
