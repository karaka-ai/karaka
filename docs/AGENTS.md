# AGENTS.md — The documentation standard

Document structure, Markdown tiers, writing rules, and `verify-doc-budgets` ceilings follow. [dsh-doc](../.agents/skills/dsh-doc/SKILL.md) governs placement and validation; [dsh-prose-standard](../.agents/skills/dsh-prose-standard/SKILL.md) governs required coverage and editorial judgment; the [doc-tiers Agent Note](../.agents/notes/implemented/process/2026-07-04-doc-tiers-and-budgets.md) owns rationale.

## Document structure

These rules govern human-facing documentation, excluding [Agent Notes](../.agents/notes/README.md). A [postmortem](postmortem/README.md) is an incident-scoped reference: chronology records evidence, not a teaching sequence. Subject and tree position determine scope regardless of document type. Describe each document's subject at appropriate depth and direct children only by purpose, responsibility, and high-level behavior; link to owning descendants for details. References may be exhaustive only about their subjects. Testing mechanisms, fixtures, and harnesses belong at the lowest owning level; higher documents link there.

Classify every in-scope document as tutorial or reference. Tutorials order steps toward an outcome, introducing only what each needs. References define lookup scope and current behavior without a teaching sequence. Separate substantial tutorial and reference content; label a small section of either kind.

Before writing tutorials, privately classify the reader's starting knowledge and each concept as beginner, intermediate, or advanced. Present prerequisites first, increase difficulty gradually, and defer unnecessary advanced material to a later tutorial or reference.

Author in order: locate the document in the tree; set permitted detail; choose tutorial or reference; order tutorial concepts by prerequisite and difficulty; relocate descendant-owned detail; replace lower-level explanations with links to their owners.

## The tier taxonomy: one home per fact

Each fact belongs to one responsible tier; elsewhere, link there.

| Tier | Job | Does NOT belong there |
|---|---|---|
| Root `AGENTS.md` | Standing orders needed every session, one to three lines each, linking their homes | Stories, worked examples, situational procedures, anything restated from a linked home |
| Subtree `AGENTS.md` (`packages/`, `docs/`, `.agents/notes/`) | Orders specific to that subtree | Repo-wide rules the root file already carries |
| [architecture.md](architecture.md) | Ordered map: composition, core packages, loop, seams, extension points; read before changing `packages/` | Type definitions (→ subsystems), per-package detail (→ package READMEs), decision rationale (→ Agent Notes), implementation-status annotations |
| [subsystems/](subsystems/README.md) | One reference page per subsystem: type definitions, semantics, and the generated Cordis API | Behavior narration (→ architecture.md) |
| [Agent Notes](../.agents/notes/README.md) | Active decision records: the why, what-was-given-up, and required verification; `implemented/` notes describe shipped reality in present tense | Migration plans, acceptance-task checklists, fixture walkthroughs, and spec-speak ("should…") once the decision has shipped; archived notes are frozen history, never current authority |
| [postmortem/](postmortem/README.md) | Incident stories — the only tier where war-story narrative belongs | — |
| [Persistence history](persistence-changes/README.md) and [format references](persistence-changes/historical-formats/README.md) | Type-change acknowledgements, release comparisons, and complete historical format schemas | Behavior-only changes; current runtime contracts |
| [cookbook/](cookbook/adding-a-package.md) | Step-by-step how-tos with numbered verify steps | Design rationale (→ the Agent Note each guide links) |
| [user/](user/index.md) | Product-facing guides published by the documentation website | Generated reference tables, contributor procedures, decision history |
| Package README | The per-package contract: config, semantics, limitations, extension points, and [Model Experience](cookbook/adding-a-package.md#4-write-the-package-readme) | JSDoc restatement, generated-catalog restatement (event/tool tables), other packages' concerns |
| [development.md](development.md) | Contributor setup, daily workflow, and a summary of CI; a bilingual pair under the [i18n contract](i18n/README.md) | Runtime/version rationale (→ Agent Notes), check-by-check lists that drift from `package.json` scripts |
| Generated reference: the per-page `cordis-surface` regions in [subsystems/](subsystems/README.md), the [Cordis core API + inherited tier](cordis-api/context.md), [tool-catalog](tool-catalog.md), [config-catalog](config-catalog.md), [persistence-catalog](persistence-catalog.md), [module-graph.md](module-graph.md) | Exhaustive English sources regenerated from source and freshness-gated; reviewed Chinese counterparts follow the [pairing workflow](i18n/README.md#scope-and-exclusions) | Hand edits to generated English sources or regions; Chinese counterparts update through pairing only |
| Skills (`.agents/skills/`) | Reusable workflows and specialized decision standards | Product and runtime contracts (→ docs or source) |

Placement: bugs → postmortems; rationale → Agent Notes; procedures → cookbooks; type definitions → subsystems; package contracts → READMEs; standing orders → root `AGENTS.md` with a rationale link.

## Writing rules

- **Document current state.** Keep history in commits, PRs, Agent Notes, postmortems, or scoped persistence records. Other prose names live mechanisms, not changes or stack positions. General Session-format prose links [version/status authority](session-format-status.md); retain numbers for version-specific contracts, examples, or evidence.
- **Apply the Agent Note creation criteria.** Mechanical/local edits are exempt, including local UI changes; keep existing owning notes accurate ([scope](../.agents/notes/README.md#when-to-write-one)).
- **One physical line per paragraph** (`verify-md-wrap`): use editor soft-wrap. Code blocks, tables, and list structure keep their formatting; code comments stay under the linter's column limit.
- **Fenced `ts` blocks must compile** (`doc-typecheck`); a pasted type declaration and its original JSDoc use ` ```ts type-equiv `, while a body-stripped public class declaration uses ` ```ts public-api `; register either in the manifest so neither can drift ([mechanics](development.md#documenting-types-verbatim-ts-type-equiv)).
- **The owning [subsystems page](subsystems/README.md) updates in the same change** that reshapes a documented type. `verify-type-equiv` catches drifted pastes, not never-documented new types; a type is documented on its declaring package group's page ([page scoping](../.agents/notes/implemented/process/2026-08-03-package-anchored-subsystem-pages.md)).
- **Pairs update together**: [Terminology-guided](i18n/terminology.md), single-pass active-agent work repositions first-use annotations, preserves untouched prose, and re-records; `dsh-translate-docs` remains user-invoked ([contract](i18n/README.md)).
- **Comments and JSDoc state complete contracts, not reasoning transcripts.** Preserve behavior, failure, timing, ownership, modality, exceptions, consequences, and non-obvious orientation; delete narration, test walkthroughs, review analysis, and code restatement. Keep the local contract and link its rationale. Use [dsh-prose-standard](../.agents/skills/dsh-prose-standard/SKILL.md) for details.
- Write directly: name actors and facts ([decision](../.agents/notes/implemented/process/2026-08-09-concrete-prose-names-actors-and-recorded-facts.md)). Reserve `seam` for the defined capability. Name the exact check, type, API, operation, or behavior instead of metaphorical "gate", "vocabulary", or "surface".

## Wordcount Budgets

[scripts/doc-budgets.manifest.json](../scripts/doc-budgets.manifest.json) sets standing-doc ceilings; `pnpm run verify-doc-budgets` rejects excess or missing files.

On failure:

1. **Relocate** content that belongs in another tier; leave a one-line link if needed.
2. **Condense** relevant content where possible.
3. **Raise** the ceiling only when the words need the space; justify the manifest diff in the PR. A too-low ceiling is a budget bug.

Ceilings are guardrails, not reduction targets. Retain at least 5% headroom at or below target; above target, freeze ceilings until relocation or condensation brings documents below target. Lower ceilings only with remaining room. Targets: root `AGENTS.md` ≤ 1,950; `architecture.md` ≤ 2,400; subtree `AGENTS.md` ≤ 600, except `packages/AGENTS.md` ≤ 750 and this file ≤ 1,320; `packages/README.md` ≤ 994; plus `cordis-primer.md` 600, `defensive-patterns.md` 550, `testing.md` 1,300, `examples/AGENTS.md` 310. Review governs unbudgeted tiers.

## The slop checklist

Audit every doc for these problems with [dsh-doc](../.agents/skills/dsh-doc/SKILL.md):

- Duplicated rules: search a distinctive phrase; keep one home and link the rest.
- History outside its permitted tier: state current facts and link the historical owner.
- Implementation-status annotations in prose or diagrams ("implemented!", "future: …"). The repo layout and package manifests own this changing information.
- Hand-restated catalogs, JSDoc, or inventories of tests, packages, and status when source or a generator is authoritative.
- Reasoning transcripts: implementation narration, obvious proofs, test walkthroughs, or rejected local alternatives. Retain resulting contracts and durable rationale; delete how they were derived.
- Rationale repeated beside sibling methods instead of once at the owning capability or helper.
- Paragraphs with several rules and parenthetical asides. Split them or move detail to its home.
- Emphasis inflation: bold, CAPS, or "critically" everywhere means nothing stands out. Reserve emphasis for the clause that changes behavior.
- Spec-speak in `implemented/` Agent Notes: "should", migration plans, acceptance checklists. An implemented Agent Note describes what is, per the [implemented-note instructions](../.agents/notes/implemented/AGENTS.md).

## Repository references

Use relative Markdown links for current files; cite history by tag or PR number. `verify-md-links` checks local targets. [Reference validation](../scripts/verify-repository-references.ts) rejects commit identifiers and disallowed organization URLs in maintained files, except [Karaka’s validated MCP `commit` field](../packages/karaka/mcp-application/UPSTREAM.json).
