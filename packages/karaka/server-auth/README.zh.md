---
description: "用于配置或排查服务器身份验证的入站应用 Bearer 验证与出站 MCP 凭据解析。"
kind: "package-reference"
---

# @karaka-ai/server-auth

[English](README.md) | 中文

## 概述

使用独立凭据验证应用服务器并授权其出站 MCP 调用。配置密钥引用后，可通过凭据提供者轮换密钥值。每次操作均解析当前值。匹配多个应用的入站凭据不授予访问权限。

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

在 `cordis.yml` 中将 `@karaka-ai/server-auth` 与 DSH 凭据提供者一同挂载。将 `applications` 设为应用记录列表，每项包含唯一非空 `id`、入站 `chatCredential` 和出站 `toolCredential`；凭据字段是 [DSH 凭据](../../credentials/credentials/README.zh.md)接受的引用。

缺失或格式错误的 Bearer 头，以及匹配多个应用的凭据，均不会返回已验证身份。未知应用和缺失的出站凭据会拒绝工具授权。提供者错误向上传播；取消操作会拒绝调用方的等待，但不会取消提供者的工作。


-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

[服务与共享 Bearer 提供者](src/index.ts)将应用身份与 Session 数据分开保存。等长密钥使用 Node 的恒定时间比较；每次请求均重新解析凭据，不缓存密钥。

不发布不变量伴随模块，因为身份验证直接根据凭据提供者的当前响应生成结果，不维护独立凭据缓存。

</details>


-----

<a id="further-exploration"></a>
## 延伸阅读

- [凭据](../../credentials/credentials/README.zh.md)：密钥引用与提供者语义。

- [身份](../identity/README.zh.md)：应用所有权。

- [浏览器身份验证](../browser-auth/README.zh.md)：签名用户凭据。

-----

<a id="model-experience"></a>
## 模型体验

### 授权

#### 模型看到的内容

`serverAuth` 不提供模型上下文；其消费者负责授权应用请求与出站 MCP 调用。

#### Token 影响

身份验证不增加输入 Token 或工具描述。

#### KV Cache 影响

身份验证不改变模型请求前缀或 KV 缓存复用。

## 已知限制与待办工作

<a id="known-limitations-and-deferred-work"></a>

部署时须考虑以下限制。

- 随包提供的提供者接受共享 Bearer 凭据；需要其他身份验证协议的部署须提供 `ServerAuth` 实现。
- 取消操作会停止等待凭据解析；凭据 API 不接受取消信号。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景 — 点击展开</summary>

无。

</details>
