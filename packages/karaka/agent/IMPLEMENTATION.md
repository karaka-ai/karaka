# Reuse-first application runtime

Karaka uses DSH `c291e7961a515f6d7af9304e7fd1d257929aef26` without changing its Session, Agent, loop, Tools, model, JSONL or query implementations. The Karaka profile adds separate durable identity and application adapters.

## Built local artifact

Build the unchanged upstream Host artifacts with TypeScript emission and the Karaka-owned `upstream.tsdown.config.ts` wrapper; the wrapper excludes Karaka packages from the upstream package pass. `scripts/build-local.mjs` then emits Karaka runtime bundles, browser bundles and public declarations against those upstream artifacts. It does not run tests or rewrite package manifests.

`scripts/materialize-local.mjs <new output directory> <built CLI repository>` copies built packages and their installed dependency and required-peer graph, including the separately built CLI. Workspace packages have one canonical runtime copy; external packages retain their installed versions. Every dependency link stays inside the artifact. The artifact's CLI resolves its Karaka server through an internal link, so it cannot accidentally launch the older registry server. The separately published SDK remains an independent dependency. `LOCAL-ARTIFACT.json` records the graph and omitted optional platform packages. The materializer creates a local artifact without registry resolution or publication; these deployment copies introduce no maintained upstream source copies.

The server's `lib/bin.js --config <patch>` interface accepts `KARAKA_HOME` and `KARAKA_AGENTS_DIR`. It initializes the Karaka profile and delegates execution to the unchanged built DSH CLI. The separate CLI can continue to own project scaffolding and foreground process supervision. Existing profile files are preserved.

## npm staging

`scripts/stage-npm.mjs <built local artifact> <new output directory> <release version>` converts the validated graph into an npm bundle. It keeps upstream packages at a canonical top-level location and nests differing external versions where required. Release-only manifests replace workspace references with exact installed versions and remove development hooks. The independent Karaka CLI is excluded from the server bundle. Browser exports, public declarations, package licenses and third-party notices remain included. Pack the staged directory with `npm pack --ignore-scripts`; this command does not publish it.

The selected upstream master shares release version numbers with npm packages that contain earlier code. For example, the selected AgentPresets implementation includes mode-selection settings and roster behavior absent from the rc.2 release branch. Bundling therefore delivers the selected source revision without substituting registry implementations or publishing new upstream packages. It does not create maintained copies of those implementations.

This initial npm build targets Linux x64 glibc and advertises that restriction in its manifest. Its README records the libvips dependency's glibc 2.28 minimum. Other platforms and native runtime paths remain outside the executed application scenario. The staging inventory records package versions and repositories; the root agent owns clean installation, the same end-to-end scenario, and publication.

The current source checkout uses a built sibling SDK at `../standalone/karaka-sdk`, relative to the server checkout, through transport-http's development dependency. That is temporary local build wiring, not a published dependency path. Replace it with the public SDK release and refresh the lockfile once that release is available. The npm server tarball contains the validated SDK runtime and has no dependency on the sibling checkout.

## Application composition

`KARAKA_APPLICATIONS` contains application IDs and incoming/outgoing credential references. Credentials resolve through unchanged DSH Credentials. The MCP endpoint, namespace and application are explicit configuration. Endpoint allow/deny is an application-wide ceiling; each preset must also explicitly allow an application tool through `@karaka-ai/agent/tool-policy`. Missing or deny-only preset policy grants no application tools. Deny wins across inherited scopes. Ordinary tool names pass through original Tools restrictions; original tool presentation controls native/PTC behavior.

The MCP bridge adapts two DSH files inside the existing Karaka MCP package: the connection supervisor and rich tool/result bridge. Its other implementation files are Karaka-owned. `../mcp-application/UPSTREAM.json` records the exact sources and changes. No unchanged dependency package is copied. Catalogs attach to owned Agents, including children with known trusted ancestry. Each execution resolves authority again, and each HTTP request resolves current credentials. Credentials do not follow redirects.

Browser routes require explicit `KARAKA_BROWSER_AUTH` public verification configuration and `KARAKA_BROWSER_ORIGINS`. The separate browser bundle preserves application chat operations, independent credentials, connection generations, reconnect and chat-scoped interaction callbacks. These routes do not expose unrestricted DSH Host remotes.

## One end-to-end flow

`e2e/application-flow.mjs` is the sole authorized scenario. It requires `KARAKA_ARTIFACT_ROOT` and the separately built `KARAKA_SDK_ROOT`. It invokes the built independent CLI to scaffold and start the actual server, creates a chat through the SDK, calls an authenticated application MCP tool through the original DSH provider and loop, receives the answer, restarts, then uses the browser facade for history and continuation before denying another owner. Its external model is a deterministic local HTTP fixture, not the DeepSeek service. The browser facade runs under Node with an explicit Origin fixture; this is not a rendered browser UI check.

The root-run scenario passed after a clean installation of all three `0.1.2-alpha.4` npm tarballs: all six milestones, three model requests and one authenticated tool invocation. Evidence is `/tmp/karaka-application-flow-jZS1P4/evidence.json`, retained by the updater at `work/reuse-implementation/evidence.json`. The server tarball contains 501 bundled package names; the local source artifact contains 515 canonical packages. Necessary runtime and public declaration builds passed. No other tests or suites ran. The release artifacts are staged; public registry availability is a separate release result.

## Remaining boundaries

The application profile has separate HTTP ingress. It does not compose the ordinary DSH Host UI/API against the same application store. Worker identity, owner-filtered cross-chat search, image upload, and full rendered browser interactions remain outside the executed scenario. Source-based child/reference adapters need their own broader evidence before claiming those surfaces fully verified. Native artifacts in a local deployment target the build host; other platforms are not verified. Registry publication, release versions and remote repository updates remain separate work.
