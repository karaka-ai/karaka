# Agent Note: Gate-runner fail-fast

Status: implemented

English | [中文](2026-08-27-gate-runner-fail-fast.zh.md)

[Parallel pre-push gates](2026-07-06-parallel-pre-push-gates.md) owns the bounded gate scheduler in `scripts/run-gates.ts`; this note adds one scheduling option to that scheduler.

## Problem

The gate scheduler in `scripts/run-gates.ts` runs every independent gate in an aggregate to completion and reports `run-gates: N passed, M failed`. A gate failure does not stop the remaining gates; only gates whose `needs` dependency failed are skipped. On an aggregate that is already red, the remaining gates keep consuming runner time and produce evidence that cannot change the verdict. The largest single cost is the instrumented coverage run in the `ci-coverage` aggregate, which has taken about 27 minutes; in `ci-consumers`, the Node compatibility smoke runs independently of the build, so it keeps running after a build failure that already settles the verdict.

GitHub Actions provides no native cross-job cancellation: `fail-fast` applies only inside a matrix, and the `all checks passed` aggregate settles only after every needed job finishes, so it cannot cancel siblings early. The only in-repository lever is the gate scheduler itself.

## Decision

`run-gates.ts` accepts a fail-fast scheduling option. When enabled, the first blocking gate failure (a gate whose `allowFailure` is not true) aborts the aggregate: the shared `AbortSignal` terminates every running gate's process tree, and every not-yet-run gate is recorded as `skipped` with the error `aborted by fail-fast: <label> failed` (or `aborted by fail-fast: host interruption` when the host signal aborted the run). The exit status remains 1, including when a killed child traps the signal and exits zero: such a result carries the abort mark and is recorded `skipped`, never passed. A gate that settled before the abort took effect keeps its real result, so the summary stays truthful about what produced evidence.

POSIX gives each fail-fast child its own process group. Abort sends `SIGTERM` to that group and its observed descendants, then escalates to `SIGKILL` after five seconds. The scheduler samples the process table at spawn and every five seconds, merges surviving cached descendants with each sample, and samples again before aborting a live root. This retains detached children whose intermediate parent later exits. Ordinary runs keep children in the host process group; fail-fast runs forward host `SIGINT` and `SIGTERM` into the abort path.

Windows uses `taskkill /PID <pid> /T /F` for the root and each observed descendant. Asynchronous process-table enumeration does not block output draining; Windows PowerShell enumeration has a ten-second timeout. Enumeration is cancelled when the gate settles. On POSIX, abort settlement checks that the process group and observed descendants stopped; after eight seconds it reports any remaining processes. A ten-second abort-only deadline closes inherited pipes that still prevent settlement. Ordinary runs continue waiting for those pipes.

Process-table sampling provides best-effort cleanup. A detached descendant created and orphaned between samples can escape discovery. Cached process identifiers can also be reused after sampling stops; the scheduler does not hold operating-system process ownership handles. The tests control sampler completion and parent exit through explicit barriers, then check that real descendants stopped. Native Windows termination remains covered by its CI lane.

The option is enabled through `DSH_GATE_FAIL_FAST` (accepted values: `1` or unset; anything else fails loud through the existing `flagEnabled` contract) on every run-gates aggregate job in `ci.yml`: the three blocking Linux jobs (`node-24` static, `node-24-coverage`, `node-24-consumers`), the Node compatibility matrix (`node-compat`), and the two native Windows lanes that drive aggregates (`windows-build`, `windows-coverage`). `scripts/ci-workflow.spec.ts` pins the flag on those jobs and pins its absence on `windows-observational`, so removing it fails the CI gate.

The `windows-observational` lane stays complete: it is `continue-on-error` by design and exists to collect as much Windows-native evidence per run as possible, so the first failure must not truncate the rest. The `windows` Wine lane and `windows-native-tests` run a single script or Vitest command rather than a run-gates aggregate, so the scheduler option does not apply to them. The master serial standby lanes (`serial-linux-selfhosted`, `serial-windows`) and the manual runner benchmarks do not set the flag: they are completeness drills that must execute the full aggregate to prove pool readiness.

Karaka retains its hosted-runner routing, two-worker budgets, SQLite differential coverage, and packed public API gates with their build dependencies. Fail-fast changes scheduling within those existing aggregates; it does not remove required checks.

## Consequences

A red pull-request run ends sooner. The largest saving is in `ci-coverage`: a failing exempt-heavy gate aborts the multi-minute instrumented coverage gate instead of letting it run out.

The trade-off is diagnostic: one push returns only the first blocking failure instead of the full failure set, so resolving several independent failures may take more push-fix rounds. Killed gates are recorded as `skipped` with the fail-fast error, so the summary line `N passed, M failed, K skipped` remains truthful about what produced evidence and what did not. A gate that ignores `SIGTERM` is force-killed after the 5-second grace. A tree that survives both signals holds the aggregate only while its direct child's stdio stays open; once `close` fires, the group-liveness poll gives up after 8 seconds and the run settles with a loud `gate tree not quiescent` warning instead of reporting a clean tree.

## Alternatives considered

**Cross-job cancellation watchdog.** A job that polls sibling conclusions and calls the run-cancel API would stop all lanes on the first failure. It is not native, adds a polling dependency and token surface, and discards the parallel evidence other jobs have already produced. Rejected; fail-fast at the scheduler is orthogonal to the job topology and carries none of that.

**Consolidating the three Linux jobs into one check.** A single job could fail fast natively, but it would lose the independent runner allocation whose queue-delay overlap is documented in the [independent CI consumer build](2026-07-30-independent-ci-consumer-build.md) note, and it would make the coverage long tail the tail of the whole job. Rejected; fail-fast applies within the existing job split instead.

**Signaling only the direct child.** The first implementation sent `SIGTERM` to the pnpm wrapper and relied on pnpm forwarding it to the script child. A probe confirmed the forwarding on POSIX. Rejected: Windows has no signal forwarding, and a wrapper-only kill orphans the script tree on the shared self-hosted pool; the tree termination above covers both platforms.
