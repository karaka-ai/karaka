---
description: "将后端签发的浏览器凭证验证为应用、租户和用户身份。"
kind: "package-reference"
---

# @karaka-ai/browser-auth

[English](README.md) | 中文

## 概述

接受短期应用凭证，无需在 Karaka 中嵌入应用登录逻辑。应用后端签署每份凭证；本插件验证凭证，并向现有浏览器连接提供完整可信 owner。

## 目录

- [配置](#configuration)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="configuration"></a>
## 配置

在应用模式 Connection 之前挂载 `@karaka-ai/agent/browser-auth`。下列字段全部必填。部署与客户端组装见 [Agent 浏览器入口](../agent/README.zh.md#browser-clients)。

| 字段 | 含义 |
|---|---|
| `applicationId` | 本部署接受的精确应用声明 |
| `issuer`、`audience` | 必需的 JWT 签发者和受众 |
| `maxTokenAgeSeconds` | 最大已签发时长和有效期，1–2,147,483 秒 |
| `keys` | 非空列表，包含唯一 `id`、`algorithm`（`ES256`、`RS256` 或 `EdDSA`）和 SPKI PEM `publicKey` |

凭证必须包含匹配的受保护 `kid` 和算法、`iss`、`aud`、`iat`、`exp`，以及非空 `applicationId`、`tenantId`、`userId` 声明。无效签名、错误声明、超长有效期和过期凭证均被拒绝。无效或重复的验证密钥会导致插件激活失败。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>验证与所有权</summary>

维护中的 `jose` 验证器依据配置的公开密钥检查签名声明。提供方返回包含原子 owner 和绝对过期时间的 `ConnectionCaller`；Connection 和 Gateway 负责 HTTP、WebSocket、授权和重连生命周期。签名密钥与登录会话保留在应用后端。

</details>

不发布运行时不变量伴生入口，因为凭据在每次请求边界解析并校验。

<a id="model-experience"></a>
## 模型体验

无，因为凭证验证不添加模型可见输入。

#### KV Cache 影响

无；验证在模型请求之外执行。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **不提供登录或令牌签发**——两者均由应用后端负责。
- **没有逐令牌撤销列表**——凭证在过期前保持有效；验证密钥变更在提供方重新加载后生效。现有 socket 在凭证过期前保留已验证身份。

<a id="dev-note"></a>
### 开发备注

<details><summary>维护者的工作上下文——点击展开</summary>

无。

</details>
