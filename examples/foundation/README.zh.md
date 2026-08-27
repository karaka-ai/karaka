# 基础示例

[English](README.md) | 中文

本示例通过真实的 Loader 和 Include 插件，从 `cordis.yml` 加载服务提供方和消费者。`provider-friendly.mjs` 与 `provider-brief.mjs` 实现相同的 `greeter` 服务；配置启用其中一个提供方，无需修改 `consumer.mjs`。

运行示例前先构建基础层：

```sh
pnpm run build
pnpm run example
```

该命令输出 `Hello, Karaka!`，然后释放完整插件树。如需选择另一个实现，请交换 `cordis.yml` 中两个提供方的 `disabled` 值。
