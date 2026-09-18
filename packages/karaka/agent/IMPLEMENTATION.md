# Karaka runtime packaging

## Summary

Karaka artifacts combine the in-tree DSH runtime with Karaka application adapters. Dependency materialization keeps one canonical runtime copy of each workspace package. The [package README](README.md) owns profile configuration and public entry points.

## Table of Contents

- [Artifact assembly](#artifact-assembly)
- [Application composition](#application-composition)
- [Integration evidence](#integration-evidence)
- [Dev Note](#dev-note)

<a id="artifact-assembly"></a>
## Artifact assembly

The [local materializer](scripts/materialize-local.mjs) copies built packages and their installed dependency and required-peer graph into a new output directory, including the separately built Karaka CLI. Workspace packages have one canonical runtime copy; external packages retain their installed versions. Dependency links remain inside the artifact. `LOCAL-ARTIFACT.json` records the graph, omitted optional platform packages, actual checkout revision and whether source has local changes. These source fields carry through npm staging; they do not prove the build origin of prebuilt outputs.

The [npm staging script](scripts/stage-npm.mjs) converts that graph into a server bundle. It keeps workspace packages at a canonical top-level location and nests differing external versions where required. Release manifests replace workspace references with exact installed versions and remove development hooks. The independent Karaka CLI is excluded from the server bundle. Browser exports, public declarations, licenses, and third-party notices remain included.

The staged server carries the selected in-tree implementations rather than resolving same-version DSH packages from the registry. Deployment copies do not create maintained upstream source copies. Staging targets Linux x64 with glibc; native dependencies and other platforms need their own artifact validation.

<a id="application-composition"></a>
## Application composition

The [bundle patch](cordis.patch.yml) uses DSH's Session, Agent, loop, tool, model, JSONL, and query implementations. Karaka keeps durable application ownership in [identity](../identity/README.md) and authenticates callers through separate application adapters. It does not add ownership fields to DSH Session records.

The [MCP bridge](../mcp-application/README.md) uses shared DSH connection supervision and rich result conversion through programmatic extensions; [its source record](../mcp-application/UPSTREAM.json) identifies shared code and application-owned adapters. Endpoint permissions and preset permissions jointly limit application tools. The [HTTP transport](../transport-http/README.md) owns conversation operations and the browser facade.

<a id="integration-evidence"></a>
## Integration evidence

The [application-flow scenario](e2e/application-flow.mjs) accepts `KARAKA_ARTIFACT_ROOT` and `KARAKA_SDK_ROOT`. It invokes the built independent CLI to scaffold and start the server, creates a chat through the SDK, calls an authenticated application MCP tool, reads the answer, restarts, and uses the browser facade for history and continuation before rejecting another owner.

This scenario supplies a deterministic local HTTP model fixture and runs the browser facade under Node with an explicit Origin. It does not establish real DeepSeek compatibility, rendered browser behavior, or broad package coverage. Its artifact and SDK prerequisites must be supplied separately from unit tests. The repository's [testing policy](../../../docs/testing.md) defines the additional evidence required for provider, transcript, and product behavior.

<a id="dev-note"></a>
## Dev Note

None.
