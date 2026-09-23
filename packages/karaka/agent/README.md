---
description: "Karaka application profile, launcher, and public tool and browser entry points for deployments using the DSH runtime."
kind: "package-bundle"
---

# @karaka-ai/agent

English | [中文](README.zh.md)

## Summary

Karaka serves application-owned conversations with authenticated server and browser access. Its application profile combines DSH's agent runtime with Karaka identity, authentication, HTTP, and MCP packages. The separately released Karaka CLI launches this profile; deployment patches select application credentials and tool access.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The Karaka CLI starts this package's `karaka-agent` executable. The executable prepares the `karaka` profile and launches its same-installation DSH CLI with `--profile karaka`. Its optional `--config <path>` argument supplies a Cordis patch to DSH. `KARAKA_HOME`, then `DSH_HOME`, selects the data home; otherwise it uses `.karaka` under the working directory. Existing profile manifests and patches are preserved. A profile that omits this bundle or links another installation is rejected.

### Configure the application

The [bundle patch](cordis.patch.yml) composes a complete application rather than extending `dsh-base`. Application records come from `KARAKA_APPLICATIONS`; their credential references resolve through [server-auth](../server-auth/README.md). The DeepSeek provider resolves `DEEPSEEK_API_KEY` and its endpoint through the shared [credentials provider](../../credentials/credentials-local/README.md). `KARAKA_MODEL` selects the default model. The declarative `application` preset in the bundle patch controls which application tools can be used through `KARAKA_PRESET_TOOL_ALLOW`. Deployments add or replace presets with `@deepseek-ai/dsh-agent-preset` rows in their profile patch.

`KARAKA_MCP_URL` enables the [application MCP bridge](../mcp-application/README.md). Endpoint allow/deny settings and preset permissions both constrain tools. `KARAKA_BROWSER_AUTH` enables [browser authentication](../browser-auth/README.md); browser origins must also be configured through `KARAKA_BROWSER_ORIGINS`. The [HTTP transport](../transport-http/README.md) owns the public route and ownership rules.

The profile explicitly disables the `session-log-deepseek` plugin's additional `dsh_session_log` request contribution. Ordinary model requests and local JSONL persistence continue unchanged. A deployment can opt in by setting `config.enabled: true` on that row in its profile patch.

### Author tools and browser clients

Tool plugins import `defineTool`, `ToolArgsError`, and their authoring types from `@karaka-ai/agent/tools`. This entry reexports the DSH definitions used by the server, preserving runtime identity. It neither mounts a plugin nor grants tool access. Presets configure `@karaka-ai/agent/tool-policy`; browser clients import `@karaka-ai/agent/browser`.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The manifest's `dsh.bundle.patch` identifies the complete profile composition. [Profile initialization](src/profile.ts) preserves existing deployment files and requires the package link to resolve to the selected installation. The [executable](src/bin.ts) delegates execution and signals to DSH. The [packaging reference](IMPLEMENTATION.md) owns artifact assembly and integration-test scope.

No runtime invariant companion is published: this package supplies composition and reexports, while each composed plugin owns its mutable state and invariants. Profile file and installation-link checks run before the DSH child starts.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Karaka package map](../README.md) — application integration responsibilities.
- [Karaka subsystem](../../../docs/subsystems/karaka.md) — authority and integration APIs.
- [Application boot](../../boot/app-boot/README.md) — profile composition and patch ordering.
- [Tool definitions](../../core/tools/README.md) — tool registration, execution, and presentation.

-----

<a id="model-experience"></a>
## Model Experience

### Application system prompt

#### What the model sees

The profile disables the default Harness identity and runtime context sections and supplies the following persona prefix through `dsh-system-prompt`; `KARAKA_SYSTEM_PROMPT` can replace it. Composed presets and tools own additional model context.

##### Default application persona

```markdown
You are a helpful assistant. Use application tools when they can answer the request.
```

#### Token effect

The persona prefix contributes its rendered text to the system message. Tool schemas and results contribute tokens according to the selected tools; the public reexport modules add none.

#### KV Cache effect

The persona text participates in the request prefix. Changing it or the selected tool schemas can change prefix-cache reuse; the DSH system-prompt and tool packages own request assembly.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The staged npm runtime targets Linux x64 with glibc; other deployment platforms require separate artifact validation.
- Deployment patches must use the active profile's plugin identifiers and configuration fields.
- Profile initialization refuses an existing link to another installation; updating that link is a deployment operation.
- The tools entry does not provide legacy plugin aliases or Session ownership fields; Karaka identity owns application authority.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
