# Vendored Packages

This directory contains source-vendored copies of the Cordis framework and its foundation libraries. Karaka owns this pinned layer so its composition lifecycle remains auditable and patchable.

All packages use the `@karaka` scope (`cordis` → `@karaka/cordis`, `@cordisjs/plugin-<x>` → `@karaka/cordis-plugin-<x>`) so Karaka can publish its fork without occupying upstream names. Directory names and upstream dependency ranges remain unchanged. `pnpm-workspace.yaml#linkWorkspacePackages` resolves internal dependencies to these pinned workspaces, including imports from built `lib/`. Schemastery's conditional `exports` map keeps ESM and CommonJS consumers on their matching artifacts. Every package preserves its upstream MIT `LICENSE`.

This file covers the manifest, local modifications, and the update procedure.

## Manifest

Upstream workspace: `cordis-workspace` (local checkout: `~/repos/cordis-workspace`).

| Directory | npm name | Upstream name | Version | Upstream repo | Commit |
|---|---|---|---|---|---|
| `cosmokit/` | `@karaka/cosmokit` | `cosmokit` | 1.8.2 | https://github.com/deepseek-harness/cosmokit | `16f6fc058ade66e8ac5da0033d35a8d0f279f544` |
| `schemastery/` | `@karaka/schemastery` | `schemastery` | 3.18.1 | https://github.com/deepseek-harness/schemastery (`packages/core`) | `e67cee00ad725bd1534aee930a979ea3eec6f698` |
| `cordis/` | `@karaka/cordis` | `cordis` | 4.0.1 | https://github.com/cordiverse/cordis (`packages/core`) | `56b3d4f725681cf4556c1a8695a709cc3b6eed74` |
| `loader/` | `@karaka/cordis-plugin-loader` | `@cordisjs/plugin-loader` | 1.0.2 | https://github.com/cordiverse/cordis (`packages/loader`) | `56b3d4f725681cf4556c1a8695a709cc3b6eed74` |
| `include/` | `@karaka/cordis-plugin-include` | `@cordisjs/plugin-include` | 1.0.6 | https://github.com/deepseek-harness/cordis (`packages/include`) | `abb0a307cb1d3b0947f455d590cf5ba922d4caa4` |
| `group/` | `@karaka/cordis-plugin-group` | `@cordisjs/plugin-group` | 1.0.1 | https://github.com/deepseek-harness/cordis (`packages/group`) | `abb0a307cb1d3b0947f455d590cf5ba922d4caa4` |
| `timer/` | `@karaka/cordis-plugin-timer` | `@cordisjs/plugin-timer` | 1.1.3 | https://github.com/deepseek-harness/cordis (`packages/timer`) | `abb0a307cb1d3b0947f455d590cf5ba922d4caa4` |
| `hmr/` | `@karaka/cordis-plugin-hmr` | `@cordisjs/plugin-hmr` | 1.0.16 | https://github.com/deepseek-harness/cordis (`packages/hmr`) | `abb0a307cb1d3b0947f455d590cf5ba922d4caa4` |
| `logger-console/` | `@karaka/cordis-plugin-logger-console` | `@cordisjs/plugin-logger-console` | 1.0.1 | https://github.com/deepseek-harness/cordis (`packages/logger-console`) | `abb0a307cb1d3b0947f455d590cf5ba922d4caa4` |

Third-party dependencies of the vendored packages stay on npm: `@standard-schema/spec`, `js-yaml`, `chokidar`, `picomatch`, `@babel/code-frame`, `supports-color`, `node-addon-require-builtin`.

Intentionally **not** vendored (verified unused by this set): `reggol`, `@cordisjs/utils`, `@cordisjs/element`, `@cordisjs/unyaml` (dev-time YAML import hook only).

## Local modifications

Keep this log exhaustive — every divergence from upstream must be listed.

1. **`hmr/src/index.ts`**: removed the `./locales/en-US.yml` / `./locales/zh-CN.yml` imports, the `.i18n({...})` call on the `Config` schema, and the `src/locales/` directory. Rationale: those imports require a runtime YAML loader hook (`@cordisjs/unyaml`) that we do not vendor; the i18n texts only localize config descriptions.
2. **All `package.json` files**: regenerated with publish metadata, precise runtime and declaration `files`, `./src/*` exports, declaration paths under `lib/types`, Karaka repository paths, and the `@karaka` scope. Dependency and peer-dependency ranges remain upstream-compatible; HMR declares the `esbuild` type dependency and Loader declares its optional internal-module helper.
3. **All `tsconfig.json` files**: regenerated to extend the repo-root `tsconfig.base.json`, emit TypeScript intermediates to `lib/types`, and declare project references.
4. **Vendored TypeScript source internal specifiers**: changed local relative imports/exports from upstream's specifier shape to explicit `.ts` specifiers so TypeScript rewrites emitted JS to `.js` while declarations keep explicit, NodeNext-safe `.ts` specifiers. This includes `loader/src/config/isolate.ts` using `declare module './entry.ts'`.
5. **`schemastery/tsdown.config.ts` and `logger-console/tsdown.config.ts`**: ours, not upstream files — per-package build-shape overrides (dual ESM+CJS output; separate node/browser entries) for the repo-root tsdown build. They read the JS emitted under `lib/types` and then write the publish runtime entries under `lib/`. Like the regenerated tsconfigs, they are not part of the upstream sync surface.
6. **`cordis/src/fiber.ts` lifecycle hardening**: locally closes three reentrant disposal gaps. An effect's owner-list wrapper is registered before its setup body runs, so an unload begun from inside setup awaits setup and every collected cleanup; synchronous setup failure removes the wrapper and rolls back collected cleanup. Async cleanup stays owner-visible until quiescence, and Cordis's internal effect composition joins an already-running cleanup while repeated public disposer calls retain their upstream single-shot result. Effect creation is rejected while the owner is `UNLOADING` (while `PENDING` and `LOADING` remain legal), preventing cleanup-time registrations from escaping the unload snapshot. Child fibers register and receive their parent-owned disposer before `internal/plugin` publication, resolve dependency declarations added by that notification before activation, drain effects attached while pending, skip plugin execution when reentrant disposal invalidates the load epoch before its first checkpoint, and contain teardown-notification failures per observer so one callback cannot starve peers or interrupt ownership cleanup. `Fiber.update()` returns its `internal/update` waterfall result, allowing Loader callers to await a restart while preserving synchronous config validation.
7. **`cordis/src/*.ts` JSDoc enrichment**: added `@param`/`@returns` tags and lifecycle, waterfall, bail, and failure documentation across the public plugin-author API. The bilingual API reference projects these declarations. Retire this entry when the documentation is upstreamed.
8. **Transactional Loader/Include config reconciliation**: Loader imports a changed entry name before disposal, awaits lifecycle settlement, and restores the previous plugin or config when candidate application fails. Group and Include updates commit only after the candidate tree settles. Covered by [`tests/loader-include.spec.ts`](../tests/loader-include.spec.ts).
9. **`hmr/src/index.ts` exact config watching**: `registerConfig()` watches one absolute path, including missing parents, serializes refreshes, and drains active work during disposal. Covered by [`tests/hmr-config.spec.ts`](../tests/hmr-config.spec.ts).
10. **Vendored Node-compatible TypeScript**: marked erased imports explicitly across `cordis`, `loader`, `include`, `hmr`, and `schemastery` so Node's native TypeScript transform does not request types as runtime exports. Schemastery's source uses an ESM default export and its package declares `type: module`; its built ESM/CJS entries retain explicit `.mjs`/`.cjs` extensions.
11. **`include/src/index.ts` patch API**: exports `applyEntryPatches()` and `entryListSchema` so offline configuration tools can share Include's exact semantics. Inserted entries are indexed immediately, allowing a later patch in the same list to configure them. Covered by [`tests/loader-include.spec.ts`](../tests/loader-include.spec.ts).
12. **Serialized Include mutation and HMR scan suppression**: Include queues child-tree mutations because Group reconciliation is not reentrant. HMR ignores the main watcher's initial scan so an already-loaded Include is not refreshed during startup. Covered by [`tests/loader-include.spec.ts`](../tests/loader-include.spec.ts) and [`tests/hmr-config.spec.ts`](../tests/hmr-config.spec.ts).
13. **`include/src/index.ts` `writeTask` type**: widened the optional `writeTask?: NodeJS.Timeout` property to `NodeJS.Timeout | undefined` — the debounced writer assigns `undefined` on flush, which `exactOptionalPropertyTypes` rejects on a plain optional. Type-only; no behavior change.
14. **Durable debounced Include writes**: writes are serialized, transient Windows rename failures are retried, asynchronous failures are observed, and teardown drains the last write. Covered by [`tests/loader-include.spec.ts`](../tests/loader-include.spec.ts).
15. **Lazy Loader config resolution**: ports [cordiverse/cordis#41](https://github.com/cordiverse/cordis/pull/41). Raw entry config resolves only after declared injections are active and resolves again after provider replacement; tree-carrier configs remain literal. Covered by [`tests/loader-include.spec.ts`](../tests/loader-include.spec.ts).
16. **`cordis/package.json` publishes `src`**: Cordis declares `"./src/*": "./src/*"`, so its tarball includes the referenced source files.
17. **`@karaka` rescope**: manifests, internal dependencies, declarations, and module specifiers use the names in the manifest table. Runtime identifiers such as `Symbol.for('schemastery')` remain upstream-compatible. `pnpm run verify:scope` rejects stale active package names.
18. **Entry `disabled` interpolation**: a `disabled: !!js` expression evaluates against the Loader context at every mount decision while the raw node remains available for write-back. Covered by [`tests/loader-include.spec.ts`](../tests/loader-include.spec.ts).
19. **Schemastery CommonJS declarations**: `schemastery/index.d.cts` describes the package's `module.exports = Schema` entry, and the conditional exports map selects it for `require()` consumers. The packed-consumer smoke type-checks and executes both ESM and CommonJS imports.

## Sync procedure

To update a vendored package from upstream:

1. In the upstream workspace, note `git rev-parse HEAD` of the relevant submodule.
2. Copy the package's `src/` (and `bin.js`, `README.md`, `LICENSE` if changed) over the vendored directory.
3. Re-apply the local modifications listed above (or drop them if upstream made them unnecessary — update the log either way).
4. Update the version and commit hash in the manifest table.
5. Run `pnpm install && pnpm run test && pnpm run build` at the repo root.
