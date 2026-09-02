---
description: "Karaka CLI for scaffolding an Agent project and launching its installed runtime."
kind: "package-reference"
---

# @karaka/cli

English | [中文](README.zh.md)

## Summary

`@karaka/cli` creates an Agent project and starts its installed `@karaka/agent` runtime. `karaka init` writes a Cordis deployment patch, one Agent Preset, a `plugins/` directory, and matching direct dependencies on the CLI and Agent packages without overwriting files. `karaka start` runs the Agent in the foreground with a private project-local `.karaka` home.

## Table of Contents

- [Commands](#commands)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

## Commands

- `karaka init --dir <path>` creates the agent workspace; the default is `apps/agents`.
- `karaka start --config <path>` prepares the project-local `.karaka` home and launches `@karaka/agent/bin`; the default patch is `karaka.cordis.yml`.

Agent Presets can load bundled `@karaka/agent/*` plugins, relative JavaScript files from the project `plugins/` directory, or optional reusable packages installed by the project. Local and installed plugins import their service and plugin APIs from the same flat `@karaka/agent/*` subpaths.

## Model Experience

None, as the CLI selects the Agent executable and deployment patch but contributes no prompt or tool definition.

#### KV Cache effect

No direct effect; the launched Agent Presets own model-request prefixes.

## Known Limitations and Deferred Work

- **Foreground process only** — the CLI does not daemonize, supervise replicas, or configure a reverse proxy.
- **Project-local Agent home** — operators must mount or back up `.karaka` when process-local persistence must survive host replacement.

### Dev Note

<details><summary>Working context for maintainers — click to expand</summary>

None.

</details>
