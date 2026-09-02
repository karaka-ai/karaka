# Agent Note: CI failover runbook — hosted pools → in-house pool

Status: implemented

English | [中文](2026-07-26-ci-failover-runbook.zh.md)

## Problem

The required Linux workers and native Windows jobs in [CI](../../../../.github/workflows/ci.yml) use standard GitHub-hosted runners. When one hosted platform degrades, every required job on that platform can queue or fail together, and merging a workflow fix may be deadlocked behind those checks. **Scope: two independent switches, one per platform.** `DSH_CI_FAILOVER_LINUX` recovers a standard Linux-pool outage for the three Linux workers plus `all checks passed`; `DSH_CI_FAILOVER_WINDOWS` recovers a standard Windows-pool outage for the four native Windows jobs. An outage therefore needs a switch a responder with repository write access can throw without merging anything.

## Decision

Each Linux worker, native Windows job, and the `all checks passed` verdict resolves its runner through a platform-specific repository variable. Unset, the jobs use `ubuntu-latest` or `windows-2025`. Set to `selfhosted`, the matching jobs from trusted same-repository, non-Dependabot branches use `vm-backup` or `dsh-win-ci`; fork and Dependabot pull requests remain on standard hosted runners. Linux failover skips hosted pnpm cache restoration because the persistent VM owns a warm store. Both topologies use the same reduced worker budgets. The standby lanes on master continue to exercise the complete unsharded aggregates on the self-hosted pools.

`ci-master.yml` exempts exactly one event from `cancel-in-progress` (`${{ github.event_name != 'push' }}`), so one master push does not cancel the drill still running from the previous one. Each drill runs its complete unsharded aggregate with one gate worker, which takes longer than the interval between master merges; under unconditional cancellation a drill is superseded before reaching a verdict and the lane yields no readiness evidence for a responder to check.

The exemption is narrower than "a drill always finishes", in two ways. GitHub keeps a single pending entry per group, so a newer pending run displaces an older one and intermediate push runs still end as `cancelled` during busy periods. And the expression is evaluated against the *newly triggered* run, so a run whose own event is not `push` — a benchmark dispatched on master within `ci-master.yml`, sharing its group `CI master-<ref>` — evaluates to `true` and does cancel a drill that is mid-flight. That is a rare manual action and the next master push restores the evidence, so it does not warrant further mechanism. What the carve-out buys is that the lane periodically reaches a verdict at all, which is what makes it usable as evidence.

The decision belongs at workflow level because cancellation applies to the whole superseded run: a job-level `concurrency` group does not exempt its job. The negated form is load-bearing rather than cosmetic: naming `pull_request` alone would also stop cancelling `workflow_dispatch`, and each runner benchmark fans out to twelve larger runners for up to fifteen minutes inside this same group on master, so a re-dispatch would queue ahead of a drill instead of replacing a stale measurement. What bounds the cost is that a master push in `ci-master.yml` carries only `wine-apt-cache` and these two drills; the pull-request jobs live in the separate `ci.yml` (which does not see `push`), and the benchmarks are `workflow_dispatch`-gated within `ci-master.yml`. `scripts/ci-workflow.spec.ts` pins that push-reachable set — classifying by exact condition, since a negated event test mentions the event it excludes — so a new push-reachable job cannot quietly start accumulating uncancelled runs.

### What the in-house pool is

`vm-backup`: one 64-core VM, six always-on systemd-managed runner instances. Its image must preinstall Playwright Chromium's Linux system packages; CI downloads the lockfile-selected browser but never runs `apt` on this persistent shared host. Check the latest `serial / linux (self-hosted standby)` run before switching: its aggregate includes browser replay, so a green standby verifies both ordinary capacity and this browser prerequisite.

#### Windows pool

`dsh-win-ci`: 32 always-on runner instances (scheduled tasks `GH-Runner-01`…`GH-Runner-32`) on the in-house Windows CI server (one 96-core / 580 GB machine). Labels: `[self-hosted, dsh-win-ci, windows]`. The image must preinstall Node 24, pnpm, Git (with Git Bash on `PATH`, i.e. `C:\Program Files\Git\bin` — the `bash` tool spawns `bash` by name), PowerShell 7, and enable Developer Mode for symlink support. Check the latest `serial / windows (self-hosted standby)` run before switching: a green standby verifies the pool can execute `check:ci:windows-complete` end-to-end.

### Switch (any repository writer, ~1 minute, no merge)

The two switches are independent: flip only the one whose platform is degraded.

1. Repository **Settings → Secrets and variables → Actions → Variables → New repository variable**: name `DSH_CI_FAILOVER_LINUX` (Linux pool outage) or `DSH_CI_FAILOVER_WINDOWS` (Windows pool outage), value `selfhosted`.
2. Retrigger the required jobs so they re-resolve their pool. Jobs already **queued** for the hosted labels do not retarget and cannot be re-run in place, so for the documented indefinite-queue outage, cancel the stuck run and re-run all jobs, or push a new commit; "Re-run failed jobs" only helps once a job has actually failed rather than queued.
3. That is the entire switch. Linux failover skips hosted-path pnpm cache restoration because the VM's persistent store serves warm installs. Both Linux pools use two single-worker instrumented coverage partitions, one exempt-heavy worker, and the same snapshot limits. The Windows switch only retargets the native Windows jobs.

#**Untrusted pull-request exception.** Both switches exclude Dependabot and require `github.event.pull_request.head.repo.full_name == github.repository`. Dependency updates and fork pull requests therefore stay on ephemeral standard runners rather than executing supplied code on persistent VMs.

**Who can flip the variable.** GitHub's API lets collaborators with write access manage repository variables, so each switch is writer-level, not strictly admin-only. The same-repository selector confines self-hosted execution to branches controlled by repository writers; the variables only route that trusted work.

## Capacity during failover

Six always-on instances absorb normal PR traffic (the pool's steady-state load is one serial standby job per master push, so failover capacity is effectively the full pool). If queues still build, register additional instances with an org registration token (org Settings → Actions → Runners → New runner). Clone an existing runner directory **excluding its identity files** — `rsync -a --exclude '.runner*' --exclude '.credentials*' --exclude '_diag' --exclude '_work' <src>/ <dst>/` (the globs also catch `.runner_migrated`/`.credentials_migrated`, which GitHub writes on migrated runners and which equally trigger the already-configured refusal) — then run `config.sh` (copying `.runner`/`.credentials` verbatim makes it refuse with "already configured"), and **start the listener**: `sudo ./svc.sh install ubuntu && sudo ./svc.sh start`. Registration alone leaves the runner offline; only a started service adds capacity. About a minute per instance.


### Switch back

Delete the `DSH_CI_FAILOVER_LINUX` or `DSH_CI_FAILOVER_WINDOWS` variable, or set it to anything other than `selfhosted`. New runs resolve back to standard GitHub-hosted pools. Remove any extra instances registered during the incident.

### Trust boundary

The variables are writer-manageable repository state; a pull request event cannot set them. Pull-request runs execute their merge ref's workflow definition, so the runner selector also requires a same-repository head and excludes Dependabot before selecting a persistent runner. Fork and dependency-supplied workflows always use ephemeral standard capacity. Runner-group policy may further restrict the self-hosted pools, but must admit the same-repository pull-request workflows that the failover is intended to run.

## Alternatives considered

**Merge a workflow change to switch pools.** Rejected because the outage that motivates the switch is exactly the state in which no PR can merge: the required checks are the ones failing. A repository variable is writer-manageable state that takes effect on re-run without a merge.

**Keep the self-hosted pool always in the required path.** Rejected because it trades hosted-pool availability for the in-house VM's, moving a single point of failure rather than adding a fallback. The variables keep the hosted pools primary and the self-hosted pools proven, one-action standbys; splitting them by platform means an outage on one platform does not retarget the other.

## Consequences

Recovering from a hosted-pool outage is flipping the affected platform's variable plus a re-run, with no merge on the critical path. The cost is a second runner topology per platform to keep working: standby lanes exercise it on master, and the Linux cache-restore branch must stay aligned with its hosted leg. Splitting the switch by platform bounds each switch to one platform, while the same-repository guard prevents that recovery path from admitting fork code.
