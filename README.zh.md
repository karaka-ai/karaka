# Karaka

[English](README.md) | 中文

Karaka 是基于 Cordis 的可配置基础层，用于组合智能体 SaaS 运行时。稳定的能力接缝定义应用能做什么，普通 Cordis 插件实现这些接缝，YAML 或编程式配置则选择实际运行的产品。

Karaka 提供的插件和用户编写的插件使用相同的服务契约、依赖跟踪、生命周期 effect 和隔离机制。第一个应用接缝是认证：`@karaka/authentication` 拥有租户路由器和提供方无关契约；其中 `authentication-jwks` 插件验证租户令牌，`authentication-host` 插件则建立由可信嵌入宿主断言的隔离身份，也是最简便的本地开发路径。

## 包

组合内核在 `@karaka` 作用域下发布九个包：`cordis`、`cosmokit`、`schemastery`，以及 Cordis 的 `loader`、`include`、`group`、`timer`、`hmr` 和 `logger-console` 插件。这些包是固定版本的 fork，本地修改记录在 [vendor/README.md](vendor/README.md) 中。

应用包位于 `vendor/` 之外。第一个应用包是 [`@karaka/authentication`](packages/authentication/README.zh.md)，其 `authentication-jwks` 和 `authentication-host` 子路径都可以通过 Loader 配置独立选择。

## 开始使用

```sh
pnpm install
pnpm run build
pnpm run example
pnpm run verify
```

[基础示例](examples/foundation/README.zh.md)通过真实的 Loader/Include 插件树组合服务定义、两个提供方和一个消费者。[Cordis 入门](docs/cordis-primer.zh.md)、[教程](docs/cordis-tutorial/index.zh.md)和[架构参考](docs/architecture.zh.md)介绍该框架。

可以通过 `pnpm run release:pack` 和 `pnpm run release:publish` 手动验证并发布包。基础阶段有意不配置 CI。

DeepSeek Harness 的历史文档和决策记录保存在 [`legacy/deepseek-harness`](legacy/deepseek-harness/README.md) 下。Git 历史保存已删除的产品源码。
