# Agent Note: Karaka workspace conformance

Status: implemented

English | [中文](2026-09-14-karaka-workspace-conformance.zh.md)

## Problem

Karaka packages are workspace members, but a separate source build does not enroll them in DSH's compiler references, source resolution, documentation catalogs or behavior tests. A passing artifact build therefore cannot establish package conformance.

## Decision

Karaka uses the repository [source import map](../../../../tsconfig.base.json), Host compiler aggregate, and root bundler. Package-local compiler and bundle configurations own additional exports and the browser entry. The standalone browser module consumes shared DSH types without a Client Cordis Context merge, so it shares the package compiler project and has a separate browser bundle. The [application build command](../../../../packages/karaka/agent/package.json) delegates to that graph. This supersedes the separate-build decision in the [CI infrastructure note](2026-09-14-karaka-ci-build-and-hosted-runners.md); its runner and credential decisions remain independent.

Package READMEs, service documentation, invariant decisions and behavior tests follow the same rules as DSH packages. The transport uses a session projection for acknowledged request IDs and model-selection state instead of deprecated synchronous history scans. The [Karaka subsystem page](../../../../docs/subsystems/karaka.md) owns generated service documentation. Compiler references resolve workspace source imports without requiring stale package declarations.

The launcher checker classifies the exact `@karaka-ai/agent` binary target and bootstrap source as a Karaka profile initializer that delegates to `dsh`. The classification preserves the [application launch rule](../../../../docs/architecture.md); it grants no independent Cordis startup or general Karaka launcher exemption.

Workspace constraints require packages in `packages/karaka/<name>` to use `@karaka-ai/<name>` and `private: true`. These packages are outside the DSH publication family; release discovery already excludes private packages. DSH public-release metadata rules remain unchanged, and shared dependency and structural checks still apply to Karaka.

The repository-reference check permits only the literal full source revision in the `commit` field of [MCP's source record](../../../../packages/karaka/mcp-application/UPSTREAM.json), after validating its repository and source-package identity. Other fields, files and organization links retain the shared check. Active notes name upstream PRs; inventing a release tag or removing the exact adoption pin would weaken the source record.

The local materializer records its actual Karaka checkout revision and whether tracked or untracked source differs. The npm staging script preserves those fields in its package inventory and describes assembly from that checkout. This identifies source inputs; it does not attest that prebuilt outputs were freshly compiled from them. Missing Git identity refuses assembly instead of substituting an upstream pin.

## Alternatives considered

**Exclude Karaka from shared checks:** this leaves integration errors undetected and does not satisfy workspace membership.

**Maintain a second compiler and documentation system:** this preserves more upstream files verbatim but duplicates policy and validation. Small explicit source aliases, compiler references and service ownership entries keep package-specific behavior local without duplicating those systems.

## Consequences

The generated Cordis API catalog includes registered Karaka services. Shared configuration contains explicit Karaka registrations that must be retained when replaying upstream commits. The [shared MCP extension decision](../architecture/2026-09-14-shared-mcp-extensions-for-karaka.md) owns the bounded upstream implementation changes that replace copied MCP code. Package checks do not settle CI process supervision or unavailable live-test credentials; those require separate evidence and decisions. Local package coverage establishes the exercised source behavior; it does not establish a passing platform matrix.
