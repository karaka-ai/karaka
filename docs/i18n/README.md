# Bilingual documentation

English | [中文](README.zh.md)

Every active Karaka document has equal-authority English and Simplified Chinese files plus an `.i18n.yaml` record of their Git blob hashes. Update both languages in one change, run `pnpm run docs:record`, and verify with `pnpm run docs:check`.

Vendored upstream documentation, the legacy corpus, and frozen archived Agent Notes are excluded. Frozen records must not be edited to satisfy active documentation checks.
