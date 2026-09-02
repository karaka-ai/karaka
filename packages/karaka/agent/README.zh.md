---
description: "自包含的 Karaka Agent runtime，内置 Cordis 插件、持久 Session、带认证的应用入口以及项目自有的扩展加载。"
kind: "package-library"
---

# @karaka/agent

[English](README.md) | 中文

## 概述

`@karaka/agent` 是完整的 Karaka Agent 服务器 runtime。它的可执行文件将 Karaka 维护的 Agent、Session、LLM、工具、持久化、Preset、认证和 HTTP transport 实现打包在一个发布包中；安装后的 runtime 不会解析 `@deepseek-ai/dsh-*` 包。服务器项目仍可通过内置 `@karaka/agent/*` 别名、项目中的相对插件文件以及由该项目安装的可选 npm 插件包来组合 Agent。`@karaka/cli` 是常规启动器，而 `@karaka/agent/bin` 是它委托的稳定进程入口。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

### 适用场景

服务器项目需要运行 Karaka 时，在该项目中安装本包。常规运行优先使用 `karaka start`；如果已有进程管理器负责启动和关闭，则可直接使用此可执行文件。应用后端应改用 `@karaka/sdk`，且不导入此 runtime。

### 入口点

```sh
KARAKA_HOME="$PWD/.karaka" npx karaka-agent --config "$PWD/karaka.cordis.yml"
```

以程序方式调用可执行文件时，`--config` 必须指定绝对部署 patch 路径。启动成功后，服务器在前台保持运行，直到收到 `SIGINT` 或 `SIGTERM`；参数无效、缺少 `KARAKA_HOME`、配置不可读、插件无法解析或插件激活失败都会以诊断信息终止进程。

### 扩展 Agent

`agent.cordis.yml` 的 row 可以指定 `@karaka/agent/persona` 或 `@karaka/agent/agent-tool-presentation` 等内置别名。每个内置别名也是 Node 子路径，并具有与其源模块相同的具名导出和默认导出。替换提供方使用的 Service Definition 模块即使不是 Loader 插件，也具有匹配的扁平子路径；例如，本地存储提供方可以导入 `StorageBackend`，而无需安装 DSH 包：

```ts
import type { StorageBackend } from '@karaka/agent/storage'
```

Agent 项目把应用专用插件放在根 `plugins/` 目录中。部署文件是 patch 层，因此新 row 必须放在 `insert` 下；此示例还选择了本地插件注册的后端：

```yaml
- id: storage-domain
  config:
    backend: customer

- insert:
    - id: customer-storage
      name: ./plugins/customer-storage.js
```

相对名称从组合文件旁解析，因此 Agent Preset 使用 `../../plugins/customer-tools.js` 加载共享根插件。可复用插件也可以是 `@acme/customer-tools` 等已安装包。两种形式都从 `@karaka/agent/*` 导入公开约定；两种形式都不依赖私有 DSH 构建输入。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

可执行文件先加载内置基础组合，再应用 Karaka 服务器 patch，最后应用 `--config` 指定的部署 patch。在 Cordis Loader 挂载任何 row 之前，插件 registry 将所有已发布的组合名称映射到静态导入的实现。精确 registry 别名优先于 Node 包解析。相对插件文件仍以组合目录为基准，而 bare 外部包使用服务器项目的配置 URL 作为 Node 解析基准。

构建会生成一组由 `lib/bin.js`、Loader registry 和 `lib/public/` 下的入口共享的 runtime chunk，因此 service 保持同一 JavaScript identity。公开 declaration facade 共用一棵私有 declaration tree；其中跨 package 引用均为相对路径，且不包含 DSH package 名称。SQLite migration 和 worker 资源随可执行文件一起发布，因为这些实现通过 `import.meta.url` 定位资源。

| 文件 | 作用 |
|---|---|
| [`src/bin.ts`](src/bin.ts) | 进程参数、Karaka home 校验和启动委托 |
| [`src/launch.ts`](src/launch.ts) | Patch 组合、项目解析基准、启动、信号和释放 |
| [`src/plugins.ts`](src/plugins.ts) | 内置 runtime 插件的精确 `@karaka/agent/*` 别名 |
| [`base.cordis.patch.yml`](base.cordis.patch.yml) | 内置 Agent runtime 组合 |
| [`cordis.patch.yml`](cordis.patch.yml) | Karaka 认证和应用 transport 扩展 |

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [`@karaka/cli`](../cli/README.zh.md) ——创建服务器项目并启动此可执行文件。
- [`@karaka/sdk`](../sdk/README.zh.md) ——将应用后端连接到运行中的 Karaka 服务器。
- [Cordis 入门](../../../docs/cordis-primer.zh.md) ——说明组合 row、Loader 解析、Service 和隔离。
- [架构](../../../docs/architecture.zh.md) ——说明此处内置的 Agent、Session、Capability 和应用层。

-----

<a id="model-experience"></a>
## 模型体验

间接地，通过每个 Agent Preset 选择的模型、提示词、工具、skill 和 policy 插件。

#### KV Cache 影响

runtime 自身不添加固定的模型文本；改变 Agent 组合可能改变该 Agent 的系统提示词或工具 schema 前缀。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **每次启动一个 Node 进程**——副本数量、TLS 终止和负载均衡仍由部署负责。
- **默认禁用本地编码工具**——Agent 需要显式可信的插件组合才能获得文件系统或子进程访问。
- **本地 TypeScript 编译由项目负责**——runtime 加载相对 JavaScript 文件；使用 TypeScript 编写插件的项目必须在启动前完成编译。

<a id="dev-note"></a>
### 开发备注

<details><summary>维护者的工作上下文——点击展开</summary>

无。

</details>
