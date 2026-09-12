# Agent Note: JSONL-only first-party Session persistence

Status: implemented

English | [中文](2026-08-30-jsonl-only-session-persistence.zh.md)

## Problem

Karaka previously selected the SQLite Session provider and retained it when upstream removed that backend. On 2026-09-11 the operator selected JSONL and confirmed that no existing chats need migration. Keeping the second authoritative format would retain its schema, resources, public exports, and cross-provider tests after that deployment need ended.

The SQLite Session-query provider owns a separate rebuildable index. The generic SQLite domain-KV provider is also independent of Session logs; neither is part of this removal.

## Decision

`@deepseek-ai/dsh-session-persistence-jsonl` is the sole first-party implementation of `ctx.sessionPersistence`. The abstract Service Definition remains backend-neutral so an out-of-tree provider can implement the same service, but the repository owns and tests one authoritative physical Session format.

JSONL headers preserve the atomic application/tenant/user owner and fork lineage. Events retain their logical order and request identities. Karaka keeps the cold-activation repair that loads preset projections before recreating an Agent. Real process restart and provider remount tests cover owner isolation, history, inherited events, and duplicate request admission.

New sessions use the JSONL root under Karaka home, with the provider's compressed default. The old `karaka-sessions.sqlite` file is not read, converted, or deleted. This deployment cutover provides no migration tool because the operator confirmed none is needed. Existing database files do not become disposable merely because this runtime no longer uses them.

`@deepseek-ai/dsh-session-query-sqlite` remains the optional FTS5 provider over a separate derived database; `@deepseek-ai/dsh-storage-sqlite` remains the generic domain-KV provider.

## Alternatives considered

- **Retain SQLite as an optional authoritative provider.** Rejected for this deployment because it retains a second physical-format and lifecycle maintenance obligation without a current need.
- **Build an offline converter now.** Not needed for the confirmed empty-chat cutover. A future deployment with retained databases needs a separately validated migration before switching; this change does not claim migration support.
- **Use the query index as authority.** Rejected because a disposable projection cannot replace authoritative Session headers and events.

## Consequences

Karaka shares upstream's JSONL durability path while retaining its ownership and cold-restart behavior. Search and domain-KV SQLite remain available. Session-format migration and handle changes remain separate work; removing this backend does not incorporate those later protocol changes.
