# Agent Note: Optional credentials do not block required CI

Status: implemented

English | [中文](2026-09-02-optional-ci-credentials.zh.md)

## Problem

Required pull-request and main-branch checks must prove that Karaka builds and its deterministic behavior works from a clean checkout. Requiring a DeepSeek API key for those checks makes repository configuration, provider availability, or account funding block unrelated source changes. Requiring a GitHub App credential for issue-project bookkeeping similarly makes optional repository automation fail when the app has not been installed.

Live-provider tests and issue-project updates remain useful when credentials exist, but neither is evidence that a source build itself needs to pass.

## Decision

The DeepSeek e2e workflow reports a notice and skips its credentialed build and suite when `DEEPSEEK_API_KEY_EXTERNAL` is empty; required clean builds and deterministic tests remain in the keyless CI workflows. When configured, the e2e workflow maps the secret only into the live test step. The installed Python wheel workflow runs every deterministic packaged-runtime scenario on every required target and runs its live DeepSeek scenario only when the same secret is non-empty. Missing provider credentials therefore skip only live-provider evidence; they do not fail the required keyless evidence.

The issue lifecycle workflow detects whether both GitHub App credential values exist before creating an installation token or mutating the configured project. Without them, it reports a notice and succeeds without project mutation. The separate issue-policy workflow remains a read-only required check using the workflow token. It checks out policy code from the default branch, then sets only the organization and repository fields from trusted event metadata before validation; other policy settings remain owned by the default branch.

Secrets remain step-scoped where practical and are never exposed to fork or Dependabot pull requests. Workflows continue to use `pull_request`, never `pull_request_target`. Publication is outside this decision: an explicit registry publication still requires registry authorization or configured trusted publishing.

## Alternatives considered

**Fail every trusted run when an optional credential is absent.** Rejected because it makes clean-build and deterministic test results depend on repository administration and external accounts. A green keyless run does not claim that live-provider behavior ran; skipped steps and suites preserve that distinction.

**Remove live-provider and project-automation paths.** Rejected because configured repositories still benefit from provider compatibility checks and project synchronization.

**Expose secrets to forked pull requests.** Rejected because untrusted code could exfiltrate them. A missing live signal on an untrusted ref is safer than granting the credential.

## Consequences

A repository with no DeepSeek key and no issue GitHub App can run all required clean-build and deterministic checks without credential failures. Its CI does not prove live-provider compatibility, and its issue project is not updated until those optional credentials are configured. The workflow UI exposes those omissions as skipped credentialed work or an explicit notice instead of treating them as source failures.
