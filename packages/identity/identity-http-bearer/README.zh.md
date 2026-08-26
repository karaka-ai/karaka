# @deepseek-ai/dsh-identity-http-bearer

[English](README.md) | 中文

这是 [`@deepseek-ai/dsh-identity`](../identity/README.zh.md) 的 HTTP Authorization Bearer 消费方。`IdentityHttpBearer` 注册 `ctx.identityHttpBearer`，只注入 `ctx.identity`，把原始 HTTP `Authorization` 值转换为 Service Definition 定义的 bearer 凭据请求，并返回 `VerifiedIdentity`。

## 服务 API

`ctx.identityHttpBearer.authenticate({ authorization, signal? })` 接受常见 HTTP 运行时暴露的字符串、字符串数组或 `undefined` 形态。它只接受一个不区分大小写的 `Bearer` scheme 和一个非空 token。缺少凭据、存在多个标头值、包含逗号、token 内出现空白、bearer 值畸形或使用其他身份验证 scheme 时，系统会在身份提供方运行前用稳定的 `IdentityError` 代码拒绝请求。

本包不注册 REST 或 SSE 路由，也不包含业务逻辑。后续传输插件注入本服务，并负责把安全的身份错误转换为自身的 HTTP 响应约定。该消费方绝不导入或选择具体提供方。

## 模型体验

### HTTP 凭据准入

#### 模型看到的内容

无。`Authorization` 解析与已验证身份不会进入提示词、工具、消息或模型请求正文。

#### Token 影响

零 token。

#### KV Cache 影响

无；该消费方不会改变模型可见前缀。

## 已知限制与暂缓工作

- **仅支持 Authorization 标头**：cookie、查询参数、mTLS 与 WebSocket subprotocol 凭据需要独立消费方。
- **不提供 HTTP 响应策略**：状态码、challenge、CORS 和安全错误正文属于调用本服务的传输插件。
- **不提供 authority scope**：后续 authority 规范化消费方必须先把 `VerifiedIdentity` 转换为应用 authority，才能执行受保护的领域工作。
