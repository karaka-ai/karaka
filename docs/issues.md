# Open Issues

English | [中文](issues.zh.md)

This is Karaka's canonical pile of concrete unresolved defects and architectural gaps found during implementation or review. It is not a feature roadmap. Keep stable IDs, record where an issue was found, and remove ambiguity about whether it blocks the change that exposed it.

An issue belongs to the current pull request when it can be corrected within the package or API introduced by that pull request. It belongs to the architectural backlog when a correct fix requires changing an existing cross-package contract or execution guarantee.

## Cross-seam backlog exposed by PR #80

These are real Karaka issues, but a provider-only patch cannot solve them safely:

| ID | Status | Owner | Issue | Required design |
| --- | --- | --- | --- | --- |
| KARAKA-004 | Deferred | Agent Runtime + Entitlement | A cancelled, failed, or incomplete upstream call may be billable but records no spend because spend currently travels only on a successful `ModelGeneration`. | Idempotent reservation and settlement, including retry and unknown-outcome semantics. |
| KARAKA-005 | Deferred | Agent Runtime + Storage | Sessions now preserve provider-neutral tool calls and results, but provider-native replay state such as reasoning items and phases still cannot survive a durable multi-turn chat. | Extend the versioned provider-neutral turn-state contract with explicit replay rules for provider-native state. |
| KARAKA-006 | Deferred | Configuration foundation | Provider credentials are ordinary schema strings. Environment fallback avoids writing a key in YAML, but Loader and schema tooling have no shared secret/redaction contract. | A secret-aware configuration and diagnostic-redaction convention usable by every provider. |

## Cross-seam backlog exposed by the tool loop

| ID | Status | Owner | Issue | Required design |
| --- | --- | --- | --- | --- |
| KARAKA-007 | Deferred | Agent Runtime + Storage + Tool | A mutating tool can complete before the durable turn commit. A crash or unknown transport outcome in that interval can cause replay to repeat the external effect. | A durable invocation journal with stable invocation IDs, checkpointing, and explicit idempotency and unknown-outcome rules. |

## Maintenance

Add an issue only when the failure mode and ownership boundary are known. When resolving one, cite its ID in the pull request and remove it from this open pile in the same change.
