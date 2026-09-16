---
description: "Karaka 浏览器传输使用的应用 JWT 验证设置与拒绝行为。"
kind: "package-reference"
---

# @karaka-ai/browser-auth

[English](README.md) | 中文

## 概述

使用公钥验证应用签发的浏览器凭据，签名私钥保留在应用后端。必须明确指定应用、签发者、受众与有效期。验证成功后返回签名中的租户、用户及到期时间。传输层负责连接到期与请求授权。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待办工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

在 `cordis.yml` 中挂载 `@karaka-ai/browser-auth`。提供非空 `applicationId`、`issuer` 和 `audience`、正数 `maxTokenAgeSeconds`，以及至少一个包含 `id`、`algorithm` 和 SPKI PEM `publicKey` 的 `keys` 项。支持 `ES256`、`RS256` 和 `EdDSA` 算法。重复密钥 ID 或无效公钥会阻止挂载。

JWT 必须包含 `exp`、`iat`、`applicationId`、`tenantId` 和 `userId`。验证会拒绝无效签名、未知密钥 ID、不匹配的声明、已过期令牌，以及超过配置上限的签发有效期。验证失败返回 `undefined`；其他运行时错误向上传播。


-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

[验证器](src/index.ts)在提供 `karakaBrowserAuth` 之前导入配置的公钥。每个 JWT 通过受保护的 `kid` 选择密钥，该密钥必须匹配受保护的算法。返回的到期时间戳以 Unix 纪元起的毫秒数表示。

不发布不变量伴随模块，因为 JWT 验证没有可变的所有权注册表或独立派生的身份验证状态可供比较。

</details>


-----

<a id="further-exploration"></a>
## 延伸阅读

- [身份](../identity/README.zh.md)：签名所有者类型。

- [服务器身份验证](../server-auth/README.zh.md)：应用服务器凭据。

- [HTTP 传输](../transport-http/README.zh.md)：浏览器入口。

-----

<a id="model-experience"></a>
## 模型体验

### 授权

#### 模型看到的内容

`karakaBrowserAuth` 不增加模型上下文或工具；传输层使用其验证后的所有者。

#### Token 影响

JWT 验证不增加输入 Token 或工具描述。

#### KV Cache 影响

JWT 验证不改变模型请求前缀或 KV 缓存复用。

## 已知限制与待办工作

<a id="known-limitations-and-deferred-work"></a>

部署时须考虑以下限制。

- 验证密钥在挂载时配置；此服务不获取 JWKS，也不管理签名密钥。
- 传输层必须在身份验证后执行 `expiresAt` 限制；此服务不管理浏览器连接，也不实现 DSH Connection 线协议。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景 — 点击展开</summary>

无。

</details>
