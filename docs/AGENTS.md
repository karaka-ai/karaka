# Documentation instructions

Maintain every active document in English and Simplified Chinese. English files use `.md`, Chinese files use `.zh.md`, and each pair has a sibling `.i18n.yaml` consistency record. Run `pnpm run docs:record` after updating both sides, then `pnpm run docs:check`.

Active docs describe Karaka's current foundation. Historical harness material belongs under `legacy/deepseek-harness/` and is excluded from active validation.
