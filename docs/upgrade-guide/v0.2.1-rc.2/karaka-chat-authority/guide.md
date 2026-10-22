---
kind: upgrade-guide
description: "Karaka replaces file-backed chat ownership with application-authorized memory identity and requires chat-scoped browser credentials."
---

# Karaka applications retain chat authority

English | [中文](guide.zh.md)

## Change

`@karaka-ai/identity` stores ownership only in memory and does not read or write its previous JSON authority directory. Session logs remain unchanged. After restart, authenticated application ingress explicitly restores ownership of a persisted root chat; ordinary owner and Session-reference lookups never restore it.

`@karaka-ai/browser-auth` requires a nonempty signed `chatId`. Browser operations and human-interaction channels accept only that chat and the root presets listed in `browserAgentIds`. Existing credentials without `chatId` are rejected. Session references require both owners to be known in the current process.

## Migration

1. Retain chat ownership in the application. Before issuing browser credentials or sending service requests, verify the requested chat belongs to that caller. Background and anonymous continuation endpoints must also verify access; a runtime service credential alone does not establish the end user's chat ownership.
2. Include `chatId` alongside application, tenant and user claims when signing browser credentials. Refresh credentials when switching chats, and invalidate cached credentials on authentication failure before a bounded retry with the same request ID.
3. Set `browserAgentIds` on the `@karaka-ai/transport-http` row. The Karaka profile accepts `KARAKA_BROWSER_AGENT_IDS` as a JSON array, such as `["application"]`; retain explicit browser origins. Custom browser ingress passes its verified `BrowserCaller` as `browser` to controller operations and calls `authorizeBrowser()` before issuing grants or causing other admission side effects.
4. Remove the identity row's `root` configuration. Custom identity callers use `new KarakaIdentity(ctx)` and explicitly call `restore(id, owner)` under `withChatLock` after verifying access to a persisted root. Keep owner queries read-only. Cross-chat references remain unavailable until each target's ownership has been independently restored.
5. Verify cold history and prompting after a restart, cross-chat and background-preset rejection, and approval isolation. Retain Session backups and a tested rollback artifact; the previous file-backed runtime cannot open chats created without corresponding authority records. Preserve its authority directory while that rollback remains relevant.
