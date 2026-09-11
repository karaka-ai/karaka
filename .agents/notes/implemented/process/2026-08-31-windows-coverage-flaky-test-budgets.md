# Agent Note: deterministic assertions and disposal budgets for Windows coverage

Status: implemented

English | [中文](2026-08-31-windows-coverage-flaky-test-budgets.zh.md)

## Problem

A real child process can take longer to report its exit under runner contention. SDK disposal tests with 100–300 ms confirmation budgets can reject a slow reap even when the disposal ladder successfully terminates the child. These tests verify escalation and cleanup, not a performance bound.

Projection-cache writes also finish asynchronously. Assertions must observe the durable row or warning that proves completion. Karaka already polls these outcomes and captures the created Session before its owning context is disposed; those checks remain unchanged.

## Decision

The real SDK initialization and disposal-ladder tests use the product's 3,000 ms signal grace. The concurrent SDK subagent diagnostic test uses the exported shutdown, EOF-grace, and signal-grace defaults. The initialization deadline and short EOF window that trigger the intended ladder remain explicit in the SDK tests.

The changed SDK ladder fixtures register cleanup before initialization. The concurrent diagnostic fixture awaits disposal of every acquired run even when an assertion or sibling startup fails. Both runs still start concurrently, and their diagnostic-category assertions remain separate.

The deterministic fake-child tests retain their 10 ms failure budgets. A child that never exits must still make disposal reject; a longer real-process confirmation budget does not turn that failure into success. No runtime timeout, persistence behavior, or CI coverage requirement changes.

## Verification

The owning suites cover projection-cache rows and warnings, real SDK process disposal, deterministic stuck-child failures, and concurrent subagent diagnostics. Independent test processes exercise the same owned resources concurrently. Native Windows timing remains the responsibility of its CI lane; local POSIX results do not establish a Windows pass.

## Alternatives considered

**Keep short real-process confirmation budgets.** These impose a reap-latency limit unrelated to the behavior under test. Product defaults give the operating system time to report exit while preserving a finite failure deadline.

**Replace durable assertions with sleeps or retry failing tests.** Neither proves the awaited state. Cache polling retains its exact row and warning assertions; the SDK tests retain their escalation and diagnostic assertions.

## Consequences

Real-process tests use deployment defaults for exit confirmation. Deterministic tests still reject stuck children within their specified budgets, and fixture cleanup awaits quiescence on assertion failures. Karaka's existing cache polling and Session-disposal coverage remain intact.
