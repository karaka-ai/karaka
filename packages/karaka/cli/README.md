---
description: "Karaka CLI for scaffolding an agent workspace and launching its persistent DSH profile."
kind: "package-reference"
---

# @karaka/cli

English | [中文](README.zh.md)

## Summary

`@karaka/cli` keeps workspace creation separate from the application SDK. `karaka init` creates a Cordis deployment patch and one Agent Preset without overwriting files. `karaka start` launches the existing `dsh` binary with the persistent `karaka` profile and a project-local `.karaka` Harness home.

## Table of Contents

- [Commands](#commands)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

## Commands

- `karaka init --dir <path>` creates the agent workspace; the default is `apps/agents`.
- `karaka start --config <path>` prepares the project-local `.karaka` home, makes the Karaka bundle and installed runtime dependencies visible to Agent Presets, then delegates launch to `dsh`; the default patch is `karaka.cordis.yml`.

## Model Experience

None, as the CLI selects a bundle and patch but contributes no prompt or tool definition.

#### KV Cache effect

No direct effect; the launched Agent Presets own model-request prefixes.

## Known Limitations and Deferred Work

- **Foreground process only** — the CLI does not daemonize, supervise replicas, or configure a reverse proxy.
- **Project-local Harness home** — operators must mount or back up `.karaka` when process-local persistence must survive host replacement.

### Dev Note

<details><summary>Working context for maintainers — click to expand</summary>

None.

</details>
