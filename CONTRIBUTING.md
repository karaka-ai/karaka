# Contributing

English | [中文](CONTRIBUTING.zh.md)

Use Node.js 22.19 or newer and pnpm 11. Install dependencies with `pnpm install`, make focused changes, and run the smallest relevant test while working. Run `pnpm run verify` before handing off a repository-wide change.

Changes under `vendor/*/src` must preserve upstream attribution, update `vendor/README.md`, and include a regression test. New application capabilities do not belong in Cordis itself: define a service, implement providers as plugins, and add consumers independently.

Update English and Simplified Chinese documentation together. Never edit or move frozen records under `.agents/notes/archived/`.
