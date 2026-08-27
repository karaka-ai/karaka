# 架构

[English](architecture.md) | 中文

Karaka 是组合基础层，不是应用运行时。其活动包图只包含 Cordis，以及加载可配置插件树所需的库和插件。

## 分层

`@karaka/cosmokit` 提供小型工具；`@karaka/schemastery` 提供配置 schema；`@karaka/cordis` 管理上下文、服务、事件、fiber、effect 和依赖跟踪。

组合插件建立在该内核之上：Loader 导入配置中的插件；Include 读取 YAML 或 JSON 配置项列表；Group 嵌套配置项；Timer 管理可释放的调度任务；HMR 重载模块和精确配置路径；Logger Console 输出 Cordis 日志。

## 应用能力

存储、身份、模型、遥测、密钥、会话、工具和智能体均有意缺席。添加每项能力时，应实现三个可独立替换的角色：

1. 服务定义声明消费者使用的 API。
2. 一个或多个提供方插件实现该 API。
3. 消费者插件依赖服务名，而不导入具体提供方。

应用通过配置选择提供方。Cordis 依赖跟踪只在必需服务存在时启动消费者，并在提供方变化时重启消费者。

## 所有权

每项注册都是由贡献插件拥有的 effect。释放插件时必须移除其服务、监听器、子插件和其他资源。[vendor/README.md](../vendor/README.md) 中记录的 Loader 和 Include 修改保证配置更新具有事务性，因此被拒绝的配置不会破坏活动插件树。
