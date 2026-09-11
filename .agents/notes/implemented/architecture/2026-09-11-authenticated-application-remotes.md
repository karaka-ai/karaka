# Agent Note: Authenticated application users on the existing Remote connection

Status: implemented

English | [中文](2026-09-11-authenticated-application-remotes.zh.md)

## Problem

A Host browser cookie grants process-wide authority. Application browsers need narrower ownership for persistent chats and human interactions, including when two users connect concurrently or reuse a browser after changing accounts. Caller-supplied tenant and user fields cannot establish that authority.

## Decision

Connection accepts either the existing Host authentication mode or an application credential provider. The bundled browser-auth provider verifies short-lived signed JWTs against configured public keys, issuer, audience, application id, and lifetime. The verified application, tenant, and user travel together as one caller; only the application backend signs credentials. Karaka contains no application login logic.

Gateway binds that caller to each invocation through a scoped Cordis context and selects methods and event recipients through the existing Remotes assembly. Browser chat methods derive the owner and delegate to the existing application controller. An approval response must name a pending event delivered to an active client generation owned by the authenticated caller. Reconnect performs authentication again and filters pending interactions by the new caller. Expiry or access-policy withdrawal aborts active application streams.

The Agent package publishes a separate browser ESM entry and relocatable declarations. It assembles Connection, Gateway, and generated Typert remotes without introducing a browser runtime plugin. The HTTP transport can disable its question handler while retaining backend routes, leaving one configured handler responsible for each human interaction.

The [Host cookie decision](2026-08-24-browser-token-authentication.md), [Remote event delivery decision](2026-08-10-remote-event-delivery.md), and [Karaka distribution decision](2026-09-02-karaka-agent-runtime-package.md) remain active: their Host authority, pending-event lifetime, and public package identity rules still apply. Application authentication adds a separate authority mode to those mechanisms.

## Alternatives considered

**A separate browser communication system.** Another gateway would duplicate typed calls, streams, reconnect state, and pending interaction delivery. Extending the existing caller path keeps ownership enforcement next to the shared dispatch and response handling.

**Trust browser-supplied owners or reuse Host credentials.** The first lets users impersonate another owner; the second grants process-wide administration. Signed application identity plus explicit capabilities limits access while reusing the durable controller checks.

**Import the server bundle into the frontend.** The server build includes Node services and a plugin loader. A separate ESM artifact retains the existing client implementation while excluding those runtime dependencies.

## Consequences

The real Karaka composition tests use two signed callers, actual approval/question services, tool execution, the agent loop, and SQLite. They verify cross-chat denial, forged approval rejection, owner changes on reconnect, pending replay, and expired credentials. Packed consumer checks compile the browser API without implicit Node types.

Pending interactions remain process-local and require routing reconnects to the same Karaka process. Credentials have absolute expiry; there is no per-token revocation list. TLS, credential issuance, and frontend credential renewal remain application deployment responsibilities. Existing sockets retain their verified caller until expiry; subsequent requests use the currently mounted verifier.
