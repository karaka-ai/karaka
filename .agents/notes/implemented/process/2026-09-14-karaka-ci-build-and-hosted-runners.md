# Agent Note: Karaka CI build ownership and hosted runners

Status: implemented

English | [中文](2026-09-14-karaka-ci-build-and-hosted-runners.zh.md)

## Problem

Organization-specific runner labels leave Karaka pull requests queued without an assigned runner. The generic DSH bundler also discovers Karaka packages whose JavaScript is emitted by a separate build, so release, preview, benchmark and Python executable jobs fail before testing. Requiring an unconfigured API secret blocks even repositories that can execute all keyless checks.

## Decision

The root [bundler](../../../../tsdown.config.ts) excludes `packages/karaka/*` in both compiler passes. [Karaka's build script](../../../../packages/karaka/agent/scripts/build-local.mjs) owns those artifacts; the upstream TypeScript graph and root bundle discovery cover the same package family.

[Pull-request CI](../../../../.github/workflows/ci.yml) defaults to `ubuntu-24.04` and `windows-2025`. Standard GitHub runners use lower gate, coverage and snapshot concurrency. The [platform failover switches](2026-07-26-ci-failover-runbook.md) and [Blacksmith overrides](2026-09-09-blacksmith-failover-leg.md) remain available when their pools are configured.

The [live API workflow](../../../../.github/workflows/e2e.yml) reports missing credentials in a notice and job summary, then skips its test job. [Python wheel CI](../../../../.github/workflows/build-exe-for-python-sdk.yml) skips only its live API step. A configured key enables the existing tests and their failures still fail CI. The [API security decision](../testing/2026-06-19-real-api-e2e-ci.md) continues to own trusted events and secret exposure.

The [preview workflow](../../../../.github/workflows/build-preview-cloudflare.yml) always builds its artifacts; deployment, protected-image verification and URL comments require all four Cloudflare credentials. Missing credentials produce a notice and summary.

## Alternatives considered

**Compile Karaka through the upstream graph:** this duplicates the existing source-build ownership and requires integrating application-specific browser and declaration entries. The separate artifact pass remains authoritative.

**Require custom runners and credentials everywhere:** that makes ordinary validation depend on infrastructure a repository may not have. Explicit overrides and visible live-test skips preserve the distinction between unavailable coverage and passing tests.

## Consequences

Standard runners may take longer, but the jobs can schedule without custom pool registration. Missing credentials provide no live API coverage; a skipped job is not evidence of provider correctness. Keyless checks remain mandatory. Workflow tests execute credential scripts with isolated output files and synthetic keys; Windows script execution requires PowerShell.
