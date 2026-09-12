# Agent Note: Track anchor container resizes

Status: implemented

English | [中文](2026-09-12-track-anchor-container-resizes.zh.md)

## Problem

A fixed portal can retain stale coordinates when its trigger moves after the window resize event. The Schedule catalog exposes this when widening across the sidebar breakpoint: the grid restores the saved sidebar width through a transition, while the trigger and catalog keep their own dimensions.

## Decision

[`useAnchoredPosition`](../../../../packages/client/ui-primitives/src/useAnchoredPosition.ts) observes the panel, anchor and anchor ancestors while open. Containing-element size changes remeasure placement through the existing ResizeObserver. Closing disconnects that observer and removes scroll/resize listeners. Unchanged coordinates retain the same state value.

## Alternatives considered

**Wait longer in the browser test.** Rejected: time does not produce a missing geometry notification, and an open catalog must follow layout changes during ordinary use.

**Measure on every animation frame.** Rejected: the reproduced movement changes ancestor dimensions, which ResizeObserver reports without perpetual work while a static panel remains open.

## Consequences

The observer watches more elements while a panel is open. It covers ancestor resizing, including animated grid tracks; transforms or position changes that resize no observed element remain outside this mechanism. Existing viewport clamping, placement gaps, tool behavior and goldens are unchanged.

The [Schedule browser case](../../../../apps/web/tests/schedule-after.e2e.ts) controls the actual sidebar expansion, verifies that the trigger moves, and compares numeric anchor/panel alignment after completion. Removing ancestor observation reproduces stale placement. [Hook tests](../../../../packages/client/ui-primitives/tests/use-anchored-position.client.spec.tsx) cover registration, remeasurement and disposal; the separate message-feedback browser owner checks another portal consumer.
