# Karaka

[English](README.md) | 中文

Karaka 是一个小型、可发布的 Cordis 基础层，面向基础设施会因部署环境而变化的应用。它提供插件组合、服务、生命周期 effect、配置加载、分组、定时器、热重载和控制台日志。它目前不提供存储、身份、模型、日志厂商、密钥、会话、智能体、工具或用户界面能力。

应用应依赖概念服务，并单独安装提供方。例如，未来的存储消费者可以依赖 `ctx.storage`，而应用通过配置选择 S3、GCS、Azure Blob 或私有实现。

## 基础包

本仓库在 `@karaka` 作用域下发布九个包：`cordis`、`cosmokit`、`schemastery`，以及 Cordis 的 `loader`、`include`、`group`、`timer`、`hmr` 和 `logger-console` 插件。这些包是固定版本的 fork，本地修改记录在 [vendor/README.md](vendor/README.md) 中。

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
