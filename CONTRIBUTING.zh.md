# 贡献指南

[English](CONTRIBUTING.md) | 中文

请使用 Node.js 22.19 或更高版本以及 pnpm 11。通过 `pnpm install` 安装依赖，保持改动集中，并在开发过程中运行覆盖改动的最小测试。交付仓库级改动前运行 `pnpm run verify`。

修改 `vendor/*/src` 时必须保留上游归属、更新 `vendor/README.md`，并添加回归测试。新的应用能力不属于 Cordis 本身：应定义服务、将提供方实现为插件，并独立添加消费者。

英文和简体中文文档必须同步更新。不得编辑或移动 `.agents/notes/archived/` 下的冻结记录。
