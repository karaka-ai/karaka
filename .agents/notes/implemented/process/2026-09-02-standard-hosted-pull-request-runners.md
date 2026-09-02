# Agent Note: Standard hosted pull-request runners

Status: implemented

English | [中文](2026-09-02-standard-hosted-pull-request-runners.zh.md)

## Problem

Automatic pull-request checks used organization-owned 16-core runner labels. Those labels require repository-external runner configuration and paid larger-runner capacity, so a public repository cannot execute its required source checks from repository configuration alone. Unavailable labels leave jobs queued without assigning a machine.

The workflow also sized gate, coverage, lint, and snapshot concurrency for 16-core machines. Selecting a smaller standard runner without reducing those process counts would oversubscribe the host and turn scheduler pressure into unreliable test evidence.

## Decision

Automatic pull-request jobs use standard GitHub-hosted capacity: Linux jobs and the Cloudflare preview build use `ubuntu-latest`, while native Windows jobs use `windows-2025`. The three Linux worker jobs and four native Windows jobs remain independent, so each job receives one runner and retains its existing diagnostic ownership. Manual larger-runner benchmarks in `ci-master.yml` remain dispatch-only.

The automatic Linux and Windows jobs cap top-level gate scheduling, lint tools, publication checks, browser workers, and snapshot processes at two where those controls apply. Coverage runs two isolated single-worker instrumented partitions beside one exempt-heavy worker, with no more than two top-level coverage gates active. This favors reliable completion on standard capacity over the larger pools' latency target.

The `DSH_CI_FAILOVER_LINUX` and `DSH_CI_FAILOVER_WINDOWS` switches retain the self-hosted fallback for trusted same-repository branches. Their selectors require the pull request head repository to equal the target repository and continue to exclude Dependabot. Fork pull requests therefore remain on ephemeral standard runners even when a failover variable is set.

## Alternatives considered

**Keep larger runners as the automatic default.** Rejected because every pull request would require paid organization capacity and runner labels that this repository cannot provision for itself.

**Make self-hosted runners the automatic default.** Rejected because persistent machines add an external availability dependency and must not execute fork-provided workflow code.

**Merge the independent jobs to allocate fewer machines.** Rejected because standard public-repository compute does not require larger-runner billing, while merging would serialize unrelated evidence and make failures harder to classify.

## Consequences

Automatic pull-request compute no longer depends on GitHub-hosted larger runners. Separate jobs still allocate separate standard machines and may take longer because each machine has less capacity; no job allocates both a standard and self-hosted runner. Actions artifact and cache storage, manually dispatched larger-runner benchmarks, and Cloudflare deployment remain separately governed resources.

The focused workflow test rejects automatic larger-runner labels, pins the reduced worker budgets, and requires the same-repository guard on every self-hosted selector. The complete platform matrix remains the execution evidence for whether the slower standard runners meet existing job deadlines.
