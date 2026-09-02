# Agent Note: Web snapshots use one browser time zone

Status: implemented

English | [中文](2026-09-02-web-snapshot-time-zone.zh.md)

## Problem

Web snapshot pages inherited the host machine's time zone. User messages persist the browser's IANA zone in `clientTimeZone`, so the same keyless replay produced different durable Session events on hosted runners and developer machines even when the product behavior was identical.

## Decision

The shared English Web snapshot page uses `Asia/Shanghai`. Scenarios that explicitly test time-zone behavior continue to create their own browser pages with an explicit zone.

## Alternatives considered

**Remove `clientTimeZone` from recorded events.** Rejected because the time zone is product input used by request-local behavior; deleting it from fixtures would hide a real regression.

**Inherit the CI host zone.** Rejected because hosted images and developer machines need not agree. One explicit browser zone makes the fixture portable.

## Verification

The Cordis lifecycle Web snapshot replays against its committed Session fixture without rewriting `clientTimeZone`. The existing schedule browser-zone scenario separately verifies the product's request-local time-zone behavior.

## Consequences

Ordinary Web snapshots no longer depend on runner locale configuration. A scenario that needs another zone must declare it when creating its page.
