# Agent Note: Pwsh bootstrap starts after initial readiness

Status: implemented

English | [中文](2026-09-02-pwsh-bootstrap-readiness.zh.md)

## Problem

The persistent pwsh backend wrote its prompt function and UTF-8 preamble immediately after the PTY provider initialized. On a loaded Windows host, PSReadLine could still be drawing the stock prompt and consume or interleave that input. The startup loop would then observe neither the installed `dsh> ` prompt nor authoritative stdin-read evidence and reject an otherwise healthy shell at the startup timeout.

## Decision

Pwsh startup begins with an empty, non-submitting send and awaits its settlement. Only then does the backend submit the encoding preamble and prompt function. The existing setup loop continues to require post-write `stdin_read` evidence containing the exact installed prompt marker, and the caller's cancellation signal and one absolute startup deadline cover both phases.

Bash startup is unchanged because its private prompt is installed through the process environment before the shell starts.

## Alternatives considered

**Increase the startup timeout.** Rejected because the failure is an input-order race; a longer wait cannot recover setup text that PSReadLine already consumed or interleaved.

**Retry the bootstrap input.** Rejected because replaying shell setup after an uncertain partial write can duplicate commands. The readiness settlement establishes one safe write point instead.

## Verification

The terminal-bash unit suite asserts the initial readiness send, the subsequent bootstrap send, prompt-marker follow-up polling, and signal forwarding across both sends. The real pwsh integration test remains the platform-owned proof that a Windows shell reaches `dsh> ` before startup completes.

## Consequences

Pwsh startup performs one additional readiness settlement before writing setup input. This removes the race with the stock prompt without weakening the installed-prompt requirement or extending the configured startup deadline.
