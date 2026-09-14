# Agent Note: Karaka workspace conformance

Status: implemented

English | [中文](2026-09-14-karaka-workspace-conformance.zh.md)

## Problem

Karaka packages are workspace members, but a separate source build does not enroll them in DSH's compiler references, source resolution, documentation catalogs or behavior tests. A passing artifact build therefore cannot establish package conformance.

## Decision

Karaka uses the repository [source import map](../../../../tsconfig.base.json), Host compiler aggregate, and root bundler. Package-local compiler and bundle configurations own additional exports and the browser entry. The standalone browser module consumes shared DSH types without a Client Cordis Context merge, so it shares the package compiler project and has a separate browser bundle. The [application build command](../../../../packages/karaka/agent/package.json) delegates to that graph. This supersedes the separate-build decision in the [CI infrastructure note](2026-09-14-karaka-ci-build-and-hosted-runners.md); its runner and credential decisions remain independent.

Package READMEs, service documentation, invariant decisions and behavior tests follow the same rules as DSH packages. The transport uses a session projection for acknowledged request IDs and model-selection state instead of deprecated synchronous history scans. The [Karaka subsystem page](../../../../docs/subsystems/karaka.md) owns generated service documentation. Compiler references resolve workspace source imports without requiring stale package declarations.

## Alternatives considered

**Exclude Karaka from shared checks:** this leaves integration errors undetected and does not satisfy workspace membership.

**Maintain a second compiler and documentation system:** this preserves more upstream files verbatim but duplicates policy and validation. Small explicit source aliases, compiler references and service ownership entries keep package-specific behavior local without duplicating those systems.

## Consequences

Hand-written upstream implementation remains unchanged; the generated Cordis API catalog includes the registered Karaka services. Shared configuration contains explicit Karaka registrations that must be retained when replaying upstream commits. Package checks do not settle fork release policy, launcher classification, CI process supervision or unavailable live-test credentials; those require separate evidence and decisions. Local package coverage establishes the exercised source behavior; it does not establish a passing platform matrix.
