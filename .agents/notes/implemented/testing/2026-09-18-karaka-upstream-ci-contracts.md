# Agent Note: Karaka upstream integration CI contracts

Status: implemented

English | [中文](2026-09-18-karaka-upstream-ci-contracts.zh.md)

## Problem

Upstream replay brings tests and generated references alongside runtime code. Repository literals, moved responsibilities and platform-specific fixture assumptions can invalidate that evidence without establishing a runtime regression. New adapter branches also need their own behavior coverage.

## Decision

Issue-policy request expectations use the repository named by the [configuration](../../../../.github/issue-management/config.json), while retaining request ordering, counts and policy assertions. The startup service belongs to the Karaka catalog and graph; a renderable service cannot remain in the catalog walk exemptions. Generated persistence display names may reorder without changing type structures or digests. Such metadata drift requires regeneration, not a migration or a fabricated history transition.

The [shared MCP extensions](../architecture/2026-09-14-shared-mcp-extensions-for-karaka.md) retain the extension object as a metadata callback's receiver. Overlapping calls retain distinct execution delegates: rejection of one authorization cannot remove another caller's image projection or dispatch a denied request. The original factory remains responsible for canonical values, admitted image storage and final content projection.

Startup admission belongs to the guard, not the HTTP controller. Its coverage uses actual Loader entries, effective disabled expressions and lifecycle disposal; route fixtures assert only transport-owned configuration and access behavior. Windows drive-relative paths resolve against the selected drive's working directory. Dependency-process fixtures use the existing Windows CI time budget without relaxing production benchmark thresholds or removing assertions.

These verification contracts complement [Karaka authority](../architecture/2026-09-12-karaka-authority-over-upstream-runtime.md) and the shared MCP decision; neither is superseded.

## Alternatives considered

Changing production repository routing to satisfy an upstream literal would target the wrong repository. Broad service exemptions, weakened coverage thresholds and handwritten schema guesses would hide drift rather than restore evidence.

## Testing

The existing policy, filesystem and dependency-resolution fixtures retain their assertions. MCP extension and startup coverage exercise the owners described above. No local tests, E2E, builds, installs or generators ran during this repair. A read-only GitHub workflow generated the catalog patch from an identified source commit; its output was inspected before application. Broader GitHub CI validation remains pending, and generation success is not a test-suite pass.

## Consequences

Configuration, runtime behavior and their verification remain separate authorities. Worker-process exits without completed suite results remain unexplained CI failures; missing coverage alone does not justify changing worker behavior or thresholds.
