# identity/ — 运行时身份

[English](README.md) | 中文

运行时身份能力家族，以及既有的匿名关联 id。身份插件接受可信宿主 id 或验证 HTTP Bearer JWT；资源授权仍是独立能力。

| 包 | 职责 | ctx key |
|---|---|---|
| [`anonymous-user-id/`](anonymous-user-id/README.zh.md) | 为遥测、反馈和 DeepSeek 请求持久化一个限定于 Harness home 的匿名关联 id | — |
| [`identity/`](identity/README.zh.md) | 可信宿主规范化与 HTTP Bearer/JWKS 验证 | `ctx.identity` |

本包合并 definition、provider 与 consumer 三种角色，因为 Karaka 当前只有一种可信宿主输入与一种 JWT 实现。组合配置只挂载一个具体配置行；在另一个实现确实需要独立替换前，不拆分 provider。
