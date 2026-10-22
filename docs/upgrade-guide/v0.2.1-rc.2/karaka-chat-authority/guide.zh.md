---
kind: upgrade-guide
description: "Karaka 用应用授权的内存身份替代文件聊天归属，并要求浏览器凭证限定聊天。"
---

# Karaka 应用保留聊天权限

[English](guide.md) | 中文

## 变更

`@karaka-ai/identity` 仅在内存中保存归属，不读取或写入原有 JSON 权限目录。Session 日志保持不变。重启后，已认证的应用入口显式恢复持久化根聊天的归属；普通归属查询和 Session 引用查询不会恢复归属。

`@karaka-ai/browser-auth` 要求非空的签名 `chatId`。浏览器操作和人工交互通道仅接受该聊天，以及 `browserAgentIds` 列出的根 preset。不含 `chatId` 的已有凭证会被拒绝。Session 引用要求双方归属在当前进程中均已确定。

## 迁移

1. 在应用中保留聊天归属。签发浏览器凭证或发送服务请求前，验证所请求的聊天属于该调用方。后台和匿名续聊端点也必须验证权限；仅有运行时服务凭证不能证明最终用户的聊天归属。
2. 签发浏览器凭证时，在应用、租户和用户声明之外加入 `chatId`。切换聊天时刷新凭证；认证失败后清除缓存凭证，再使用相同请求 ID 进行有界重试。
3. 在 `@karaka-ai/transport-http` 配置行设置 `browserAgentIds`。Karaka 配置档案通过 `KARAKA_BROWSER_AGENT_IDS` 接收 JSON 数组，例如 `["application"]`；保留显式浏览器来源。自定义浏览器入口将已验证的 `BrowserCaller` 作为 `browser` 传给控制器操作，并在签发授权或产生其他准入副作用前调用 `authorizeBrowser()`。
4. 删除 identity 配置行的 `root`。直接调用 identity 的代码使用 `new KarakaIdentity(ctx)`，并在验证持久化根聊天权限后，于 `withChatLock` 中显式调用 `restore(id, owner)`。归属查询保持只读。每个目标的归属被独立恢复前，跨聊天引用仍不可用。
5. 验证重启后的冷历史读取和提示提交、跨聊天及后台 preset 拒绝，以及审批隔离。保留 Session 备份和经过测试的回滚产物；原有文件运行时无法打开缺少对应权限记录的新聊天。该回滚仍适用期间，保留其权限目录。
