# Agent Note: Ban an ambiguous origin label

Status: implemented

English | [中文](2026-08-26-ban-ambiguous-origin-label.zh.md)

## Problem

The case-insensitive ten-letter ASCII token formed by `prove` followed by `nance` had accumulated unrelated meanings across the repository. It named source-event references, provider and model metadata, context producers, installed artifact identity, configuration origins, browser-recording evidence, and release attestations. A reader could not determine the recorded fact from the label alone.

The existing [concrete prose decision](2026-08-09-concrete-prose-names-actors-and-recorded-facts.md) required sentence-level classification and normally preserved identifiers. That policy improved individual sentences but allowed the same ambiguous label to remain in APIs, durable compatibility fixtures, filenames, generated catalogs, and new prose.

## Decision

Maintained tracked paths and text must not contain that token in any case variant. Each use is replaced with the exact local concept, such as source-event references, provider metadata, model identity, context producer, configuration source, artifact identity, or recorded evidence.

The rule applies to source, tests, documentation, active Agent Notes, prompts, snapshots, workflow files, scripts, identifiers, fields, exported types, and filenames. Because the repository is pre-release, coordinated public symbol and current durable-field renames are preferred over aliases. A compatibility reader may reconstruct the retired durable key at runtime without embedding the token in maintained text.

`verify-concrete-terms` scans tracked filenames, symlink targets, and text case-insensitively after NFKC normalization. It runs as a quick leaf of `doc-sync`, and its tests prove rejection in prose, identifiers, and paths. Vendored sources and frozen archived Agent Notes remain excluded because their repository policies prohibit direct edits.

This decision partially supersedes the earlier decision's rejection of fixed word bans and identifier renames for this one token. The earlier decision remains active for all other abstract language and for choosing each replacement according to its local meaning.

## Alternatives considered

**Continue semantic review without a mechanical ban.** Rejected because the label had already spread through unrelated contracts, and sentence-level review could not prevent recurrence in identifiers, fixtures, or filenames.

**Replace every occurrence with one umbrella term such as `origin` or `source`.** Rejected because one new broad label would preserve the ambiguity between event references, model metadata, build identity, and recorded evidence.

**Exempt identifiers, durable fields, and generated files.** Rejected because callers and generated reference material would continue teaching the retired label. The pre-release policy permits coordinated renames, while the legacy parser can retain read compatibility without retaining the literal token.

**Scan vendored and archived sources.** Rejected because vendored content is updated through its synchronization procedure and archived Agent Notes are frozen records. Their explicit exclusions keep this policy consistent with those ownership rules.

## Consequences

Callers use more specific public names, and current recordings use provider metadata instead of the retired assistant field. Generated catalogs and recorded snapshots must be refreshed when an owning symbol changes. Compatibility code remains responsible for reading the retired durable field.

Future uses fail `doc-sync` with the matching path or line. Reviews still classify the intended meaning before choosing a replacement; passing the gate proves absence of the token, not that the replacement is precise.
