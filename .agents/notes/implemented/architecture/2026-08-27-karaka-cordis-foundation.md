# Agent Note: Reset to the Karaka Cordis foundation

Status: implemented

English | [中文](2026-08-27-karaka-cordis-foundation.zh.md)

## Context

The repository implemented a complete agent product with 227 harness packages, several applications, native and Python distributions, and product-specific automation. That graph made it difficult to establish infrastructure contracts independently: storage, identity, models, telemetry, and sessions already carried product assumptions before a SaaS application selected its providers.

The vendored Cordis layer already supplies the mechanism Karaka needs. Services name capabilities, providers register implementations as plugins, consumers inject service names, and lifecycle effects reverse every contribution when a plugin unloads.

## Decision

Karaka retains only the nine publishable Cordis foundation packages under `@karaka/*`: Cordis, Cosmokit, Schemastery, Loader, Include, Group, Timer, HMR, and Logger Console. The repository keeps their pinned upstream attribution, documented local divergences, focused regression tests, a Loader/Include example, bilingual foundation documentation, and manual release tooling.

Agent, tool, model, storage, identity, session, UI, native, and SDK implementations are absent. Each future application capability must begin with a service definition, then add provider and consumer plugins without coupling the service API to one vendor. The reset supplies no compatibility aliases for the former package scope or on-disk formats.

DeepSeek Harness documentation and active decision records remain as an excluded legacy corpus. Removed product source remains in Git history. Frozen archived Agent Notes remain at their original paths because their content seals prohibit moves and edits.

## Alternatives considered

Keeping the agent spine would preserve working behavior but would make the old product architecture the default starting point. Keeping only the raw Cordis kernel would discard Loader, Include, HMR, and the local transactional fixes required for configuration-driven applications. Returning to clean upstream sources would also discard fixes whose failure modes are already understood and recorded.

## Consequences

Karaka has no usable SaaS or agent capabilities until later plugins introduce them. Publication is manual and the repository has no CI configuration during this phase. Package consumers must migrate to `@karaka/*`; earlier package names do not resolve.

The smaller graph makes each new capability an explicit architectural choice. A provider swap can change an application's infrastructure without changing consumers, while Cordis remains responsible only for composition and lifecycle.

## Verification

The active workspace contains the nine foundation packages and one private example. Type checking, unit tests, built-example execution, documentation pairing, package metadata validation, publint, and tarball creation cover the retained surface. Tests linked from `vendor/README.md` protect local source divergences without importing deleted harness code.
