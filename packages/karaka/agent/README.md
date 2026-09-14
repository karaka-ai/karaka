# Karaka Agent

Karaka composes an application server from unchanged DSH implementations and Karaka identity, authentication and transport plugins. The separately released CLI launches its DSH profile.

Local tool plugins import `defineTool` and `ToolArgsError` from `@karaka-ai/agent/tools`. This entry reexports the server's original DSH tool definitions and authoring types, preserving runtime identity. Tool registration and execution use the existing `ctx.tools` service. The entry does not mount a plugin or grant tool access; presets select allowed tools through `@karaka-ai/agent/tool-policy`.

## Model Experience

The tools entry adds no prompt, model call, token cost or KV-cache change. Registered tool schemas and results follow DSH's tool pipeline.

## Known Limitations and Deferred Work

The npm runtime currently supports Linux x64 with glibc. Deployment patches must use the active profile's plugin identifiers and configuration contracts. The tools entry does not restore removed plugin aliases or Session ownership fields.
