---
description: "Persistent Karaka bundle combining DSH Agent Presets, SQLite sessions, authenticated application ingress, and remote MCP tools."
kind: "package-bundle"
---

# @karaka/harness

English | [中文](README.zh.md)

## Summary

`@karaka/harness` is the persistent Karaka server bundle over `dsh-base`. It composes Agent Presets, SQLite Session persistence, the workspace registry required by Session Controller, the shared Host web server, server authentication, and application HTTP transport. It also makes the authenticated application MCP bridge resolvable for remote tool endpoints. Application-owned endpoints belong in the deployment composition; ordinary MCP endpoints may live in an Agent Preset. Its safe default disables local coding and shell tools; each agent directory supplies its own Cordis composition.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

## Use this package

The `karaka` profile mounts this bundle through the existing DSH Loader. Configure applications and authenticated MCP endpoints in the deployment's `karaka.cordis.yml`; define each named agent under `agents/<id>/preset.yml` and `agents/<id>/agent.cordis.yml`.

## Model Experience

Indirectly, through the model, prompt, tool, skill, and policy plugins selected by each Agent Preset.

#### KV Cache effect

The bundle adds no text itself; changing an agent composition can change that agent's system-prompt or tool-schema prefix.

## Known Limitations and Deferred Work

- **One Node process per launch** — replica count and load balancing remain deployment concerns.
- **Local coding tools are disabled** — an agent needs an explicit trusted plugin composition to regain filesystem or subprocess access.

### Dev Note

<details><summary>Working context for maintainers — click to expand</summary>

None.

</details>
