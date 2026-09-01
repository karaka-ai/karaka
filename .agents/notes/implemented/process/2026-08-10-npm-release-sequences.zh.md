# Agent Note: 四条独立序列的 NPM 发布

Status: implemented

[English](2026-08-10-npm-release-sequences.md) | 中文

## 问题

这个仓库有多组互不相干的可发布包，却没有任何发布通道把它们送上 registry。后来，Karaka 在 `packages/karaka/*` 下增加了第四个产品族。

`packages/*/*` 与 `apps/*` 组成 `@deepseek-ai/dsh` 的运行面；`packages/karaka/*` 组成公开的 Karaka 产品面；`vendor/*` 是九个 rescope 过的 Cordis 框架包；`native/landlock-run/packages/*` 是 Linux 平台包。它们的版本所有权、发布节奏与构建要求不同。把它们塞进一条流水线，会让互不相关的族一起重复发布。

挡路的还有两处硬门。全部 217 个 workspace manifest 都是 `private: true`，`npm publish` 直接拒绝。更隐蔽的是 933 条 dsh 兄弟包之间硬写的 `peerDependencies: "^0.0.1"`：`pnpm pack` 只替换 `workspace:` 协议，不动语义范围，而 `^0.0.1` 等于 `>=0.0.1 <0.0.2`——发 `0.0.2` 落不进去，发 `0.0.1-rc.1` 也落不进去（semver 规定不带预发布段的范围排除预发布版本）。这些条目至今没出事，只因为版本一直停在 `0.0.1`。

`scripts/publish-npm-baseline.ts` 是本机发布脚本：它把 pack 与 publish 放进同一个进程，需要人工在本机完成认证与重试，且把 vendor 排除在发布集之外。它不能作为 CI 发布的基础，但其中的 tarball payload 校验与已安装产物探针是验证过的零件。

## 决策

### 四条独立序列

DSH、Karaka、vendor 与 native 各自拥有一条 bump 序列和一次发布。发布一个族不会重新发布另一个族。

| 序列 | 成员 | 版本基线 | tag | workflow |
|---|---|---|---|---|
| dsh | 发布集：非 experimental 的 `packages/*/*` + `apps/*`；私有实验性包仅加入共享版本 bump | 发布集、私有 dsh 包与 workspace 根共用一个 `0.0.x` | `dsh-v<版本>` | `release.yml`（pack）/ `release-publish.yml`（发布） |
| Karaka | `packages/karaka/*` | 一个公开产品版本 | `karaka-v<版本>` | `release-karaka.yml`（pack）/ `release-karaka-publish.yml`（发布） |
| vendored framework | `vendor/*` 九个包 | 每包各自一条版本线 | `vendor-<包名>-v<版本>`（每包一个） | `release-vendor.yml`（pack）/ `release-vendor-publish.yml`（发布） |
| native | `native/landlock-run/packages/*` | 自己的 `0.0.x` | `landlock-run-v<版本>` | `landlock-run-release.yml` |

DSH、vendor 与 native 发布到 `@deepseek-ai`，Karaka 发布到 `@karaka`。access 由 manifest 决定：当前所有可发布包都是公开包（[理由](2026-08-13-public-vendor-and-native-sequences.zh.md)）。发布路径不会用 `--access` 覆盖它。

### 版本由本地命令写进仓库，CI 只核对与上传

每条序列有一条 bump-and-commit 命令：算出目标版本，写进相关 manifest，跑 `pnpm install --lockfile-only`，再把 manifest 连 lockfile 一起 commit。发布版本因此在仓库里查得到。tag 由人工在 commit 合入仓库默认分支后打；CI 不写仓库，也不需要写权限。

`release:dsh` 接受 `major`、`minor`、`patch` 或显式版本号，把同一个版本写进可发布族、`packages/*/*` 下的每个私有包**以及 workspace 根**。私有包不会获得发布 tag，仍位于 pack 与 publish 之外；它们跟随版本是因为 workspace 约束要求每个 dsh 包的版本等于根版本。根的检查接受预发布段，因此 `0.0.1-alpha.1`、`0.0.1-canary.1` 和 `0.0.1-rc.1` 等显式版本走同一条 pack、已安装产物探针和发布路径。发布 dsh 时，`alpha` 和 `canary` 分别映射到同名 npm dist-tag，包含 `rc` 在内的其他预发布版本映射到 `next`，稳定版本则沿用 npm 默认的 `latest`。其他发布家族保留各自的 dist-tag 规则。

基础版本号相同时，SemVer 按字典序比较字母数字型预发布标识：`alpha` 小于 `canary`，`canary` 小于 `rc`，所有预发布版本都小于稳定版本。npm dist-tag 是可变别名，不参与版本优先级比较。

### vendor：谁改了谁发版，tag 就是账本

vendor 九包加了 scope 之后与上游脱钩，但保留各自的版本线。发布版本取「manifest 版本」与「上次发布版本」中较高的那个，再递增 patch——这一步同时去掉上游的预发布段。首发版本：

| 包 | 上游版本 | 首发版本 |
|---|---|---|
| `@deepseek-ai/cordis` | 4.0.0-rc.7 | 4.0.1 |
| `@deepseek-ai/cordis-plugin-loader` | 1.0.0-rc.5 | 1.0.1 |
| `@deepseek-ai/cosmokit` | 1.8.1 | 1.8.2 |
| `@deepseek-ai/schemastery` | 3.18.0 | 3.18.1 |
| `@deepseek-ai/cordis-plugin-hmr` | 1.0.15 | 1.0.16 |
| `@deepseek-ai/cordis-plugin-include` | 1.0.4 | 1.0.5 |
| `@deepseek-ai/cordis-plugin-timer` | 1.1.2 | 1.1.3 |
| `@deepseek-ai/cordis-plugin-group` | 1.0.0 | 1.0.1 |
| `@deepseek-ai/cordis-plugin-logger-console` | 1.0.0 | 1.0.1 |

以「上次发布版本」为基线才扛得住重同步：本仓发过 `4.0.1` 之后上游把版本恢复成 `4.0.0-rc.8`，只看 manifest 会再算出 `4.0.1` 并撞上已发版本。加 `--prerelease rc.1` 则发一次排练版：它进 `--tag next`，而且不占用那组数字——预发布的优先级低于它所先行的正式版，所以 `4.0.1` 仍然接在 `4.0.1-rc.1` 之后。这个次序由脚本自己算，不读 `git tag --sort=v:refname`——git 会把预发布排在正式版之前。

只发改动过的包，而变更判据不引入新的状态文件：**每包一个 tag，tag 就是「上次发布到哪个 commit」的记录**。bump 对每个包取最新的 `vendor-<包名>-v*` tag，拿包目录与它做 diff。一条路径算命中的条件是：manifest 的 `files` 选中它，或 npm 无论如何都会发布它（`package.json`、`README*`、`LICENSE*`），或者——当该包的 `files` 选中 `lib/` 时——它是构建输入（`src/**`、`tsconfig*.json`、构建配置）。最后那条规则的存在理由是构建产物不在 git 里：没有它，真实的源码改动会读成「没变化」，而下一次发布会在一个字节已变的版本上失败。

tag 只是 commit 指针，不是发布成功的证明。bump 会向 registry 核对「最新 tag 指向的版本是否真的存在」，不存在就明确失败交人处理——否则一个为失败发布而推的 tag 会被读成「已发布」，从此永远跳过该包。查询私有包需要凭据，因此未鉴权的机器只报告这道核对被跳过，不失败。

`vendor/cordis` 现在也发布 `src`。它的 exports 声明了 `"./src/*"`，tarball 里没有这些文件就等于把消费方指向不存在的路径；而 `files` 只选构建产物，也让变更判据没有任何受 git 跟踪的路径可匹配。

### 发布只在 GitHub 执行，由 registry 状态决定发什么

发布只从 GitHub Actions 执行，没有本机发布路径。publish 不读 tag、不读任何「本次发布包含什么」的清单，而是对每个打包好的 tarball 拿版本与 registry 比对，分三态：

| 状态 | 处置 |
|---|---|
| registry 上没有该版本 | 发布 |
| 已有该版本，且 tarball 的 sha512 等于记录的 `dist.integrity` | 跳过：这是同一批产物的重跑 |
| 已有该版本，但 integrity 不同 | 失败退出，报「内容已变但版本未 bump」 |

第三态拦住「改了代码却没 bump 版本」。前两态给出幂等——同一个 artifact 重跑 publish 不会重复发布，也不需要人工挑拣包。同一条规则还解决了「一次 vendor 发布携带多个 tag，而 workflow 只能从一个 ref 触发」的矛盾：workflow 从不从触发它的 tag 去推断该发哪些包。

四条序列都按这套判定，native 也在内：它通过自己的脚本发布，而不是 shell 循环——一串裸 `npm publish` 无法重试，registry 对「重发已存在的版本」的回答是永久失败，因此中途失败一次就没有前路了。

registry 的两个行为决定了「怎么尝试一次发布」。写入之间至少间隔两秒并带退避重试，因为连续背靠背发多个包会超出 registry 自身的处理速度，换来 `E409 Failed to save packument`。而每次重试都先重查 registry：报出来的失败可能对应一次其实已经落地的写入，所以「该版本现在存在且 integrity 与本 tarball 相同」算作已发布，而不是又一个待放置的版本。

### workspace 内部引用走 `workspace:` 协议

所有指向 workspace 成员的引用都用 `workspace:^`，由 `pnpm pack` 替换成匹配目标版本的范围：兄弟包的 `peerDependencies` 跟随族版本，指向 vendored 包的引用跟随那个包自己的版本线。Landlock 平台包保留 `workspace:*`（发布成精确版本），因为平台包与它的入口必须版本完全一致。

`scripts/check-workspace-constraints.ts` 要求这个协议，所以新包无法再引入硬写的范围；同理，invariant companion 规则要求 `@deepseek-ai/dsh-invariants` 用 `workspace:^`。

### 发布依赖门面使用显式策略

[`verify-package-dependencies`](../../../../scripts/verify-package-dependencies.ts) 按已发布的 Client 与 Host 用法分类 workspace 关系，让受管包只保留 Cordis peer，并应用一份较小的显式 Host 名册。[发布依赖门面与有限 peer 中继](2026-08-26-published-dependency-faces.zh.md)记录选包规则与理由。

`pnpm run benchmark:npm-resolution` 使用当前安装的 npm 手动测量该依赖图。`pnpm run benchmark:npm-resolution:next` 还会逐个尝试每个可达且未配置的 Host 包，再串行复测领先候选。两个命令都使用回环 metadata registry 并拒绝包归档请求，因此耗时不包含包下载。调度器负载与 metadata 完成顺序会使墙钟阈值失去确定性，所以两个命令都不进入聚合门禁。

### optional 依赖绝不在模块作用域被加载

`optionalDependencies` 里的依赖，或带 `peerDependenciesMeta.<name>.optional` 的 peer，在安装出来的树里可以不存在——这份「可以不存在」正是 optional 的全部承诺。而静态 import 在引入方模块加载时就求值，于是一个缺失的包不再表现为「这个能力不可用」，而是变成所有能走到该模块的代码的加载失败。这种失败只在「缺了该包的安装树」里出现，而本仓没有任何测试构造这种树：workspace 安装总是把每个包都装上，所以单测、快照、打包安装探针全都会过，而那个拒绝了这个 optional peer 的消费者拿到的却是坏的包。

[`verify-optional-dependency-imports`](../../../../scripts/verify-optional-dependency-imports.ts) 堵掉这个洞。它从每个包自己的 manifest 读取「这个包允许谁缺失」，再扫描会发布出去的文件——`packages/*/*/src/` 与 `apps/*/src/`——且两个编译门面各扫一遍。`vendor/` 不在范围内，那是[受 vendoring 政策管辖](../../../../vendor/README.md)的固定上游源码。值与类型的判定对着绑定好的 Program 做，而不是看 import 写法，因为 `verbatimModuleSyntax` 是关的：编译器本来就会消除绑定解析为类型的 import，所以 `import type {}`、`import {}`、内联 `type` 说明符、以及解析为类型的具名绑定都不产生产物、一律放行，而裸 import、值绑定、星号 re-export 会被保留、一律报错。只有 type 相位会消除 import：`import defer` 仍然解析并链接它的模块，只推迟求值，所以门禁把它算作一次加载。

报错会点名这个包、点名是哪条声明把它标成 optional 的，并按顺序给出出路——把它作为类型引入（声明合并需要的仅此而已），或者调整写法让模块作用域不再需要这个包。动态 `import()` 只是把失败推迟到首次使用，它属于那种确实需要这个包、并且自己处理缺失的调用方；会想到它，往往说明这个依赖并不 optional，所以门禁不把它作为解法给出。

### 发布族对象

这个领域里的实体是**发布族**：一组共享版本基线与 tag 命名、可整体发布的包。新增一族等于加一个子类和一条 workflow lane，不改核心。

| 对象 | 职责 |
|---|---|
| `ReleaseFamily` | 一族的身份：成员发现、版本基线、tag 前缀、打包 payload 规则、已安装入口 |
| `ReleaseMember` | 一个可发布包：目录、包名、版本、manifest |
| `publishOrder` | 按 npm 会安装的依赖段加 peer 声明做拓扑序，同层按包名排；安装依赖成环是报错而不是随意定序，任何排不进去的 peer 边被丢弃并点名 |
| `pack` | 把整族打进一个目录并记录上传顺序 |
| `verify` | 族的版本基线、完整打印出来的发布顺序；发布时还要求本次运行来自该族的 tag、且成员可发布 |
| `verify-packed-install` | 把一个或多个 pack 目录的 tarball 装进一次性 consumer，并驱动已安装的可执行入口 |
| `publish` | 上面那三态 |
| `process` / `tarball` | 启动命令、读取打包 tarball 的唯一正家，其中的入口守卫让每个脚本都可被 import |

dsh 族套用仓库的发布 payload 策略（拒绝源码与声明映射）。vendored 族保留上游 payload，因为那些 manifest 导出 `./src/*`，去掉 `src` 会发出一个导出映射指向不存在文件的包。

### workflow 形状：PR/push 上 pack，从手动 dispatch 工作流发布

`pack` job 遍历一个发布集，写出上传顺序，再把目录作为一份 artifact 上传。DSH、Karaka 与 vendor 使用独立的排练 workflow。一个族仍是整体：不会在其他成员仍在构建时发布其中一部分。

`pack` 无凭据，在每个 pull request 和每次默认分支 push 上运行。每个族都有独立的手动发布 workflow，并由 `npm-publish` environment 审批。pack 按 ref 分组；publish job 共用全局 `Release-publish` 分组，因为 dist-tag 是共享的 registry 状态。

dsh 的验证会一并安装 vendored 族的 pack 产物。harness 的包把 vendored 框架声明成 peer，而那些包属于另一条序列，无凭据的 job 无法从私有 registry 取到——所以 dsh 的 `pack` job 为验证而打包 vendored 族，发布的仍只有 dsh 那一份。发布工作流（`release-publish.yml`）重新打包当前树，只发布 dsh 族。

Karaka 验证会安装本地打包的 Karaka、DSH、vendor 与 Landlock 产物，但发布 workflow 只上传 `@karaka/*`。必须先发布匹配的依赖族，再调度 `release-karaka-publish.yml`，保证每个已发布 Karaka 依赖树都能立即安装。

验证还会打一份 Landlock entry 的 tarball——`dsh-sandbox-local` 把它声明为普通 `dependencies`——同时略去可选依赖。那些可选项背后的平台包需要 musl 工具链且每个架构各构建一次，单台 runner 产不出来；而装不到它们的消费方也必须能起，这正是「可选」在这里的含义。因此验证按目录内容读取 tarball，而不是读发布顺序：一个目录可能只装着为满足跨序列依赖而打出来的包，任何发布顺序都不描述它。

### 本次带出的仓库改动

| 项 | 内容 |
|---|---|
| 发布集 manifest | 去掉 `private: true`；按序列补 `publishConfig.access` 与带各自 `directory` 的 `repository` |
| 发布集边界 | `packages/*/*`、`apps/*`、`vendor/*` 的全部成员 |
| 依赖协议 | workspace 内部引用为 `workspace:^`，由 `check-workspace-constraints.ts` 与 invariant companion 规则强制 |
| 根 `AGENTS.md` | 「vendored 包是 `private: true`」这条约定不再成立 |
| `vendor/README.md` | 记录「`src` 加入 `cordis` 的 `files`」这条本地修改 |
| native 三包 | `publishConfig.access: public`，且其 workflow 不传 `--access` |

### 与先前提案的关系

本 Note 取代 [以产物为先的 NPM 基线发布](../../proposed/process/2026-08-04-artifact-first-npm-baseline-publication.zh.md) 中的版本方案与发布集边界：那篇的 `<base>-<时间戳>-<短 SHA>` 预发布版本与 `dev-<base>` dist-tag 不再采用，vendor 也不排除在发布集之外。两篇一致的部分保留：pack 与 publish 分离、publish 只消费已验证的 tarball、payload 与安装后探针作为发布门。

## 曾考虑的替代方案

**`<base>-<时间戳>-<短 SHA>` 版本号。** 曾计划用于持续 dev 发布。它与「把发布版本留在仓库里」冲突：版本内嵌 commit SHA，而把版本写回会产生新的 commit，于是 SHA 只能指向被发布的父 commit，这条链要靠约定解释。改用数字版本后，`0.0.1-rc.1` 这类预发布号已经覆盖「先验证再正式发」。

**用 `vendor/published.json` 账本记录每包的已发版本与 commit。** 这是 tag 方案之前的设计。它新增一份必须与 registry 不漂移的状态文件；per-package tag 提供同样的 commit 指针，而 tag 本来就要打，不引入第二处状态。

**事件级 tag（`vendor-r1`、`vendor-r2`）。** 为「一次发布事件携带多个包版本」准备。既然由 registry 决定发什么，workflow 就不再从 tag 推断集合，per-package tag 够用，而且每个 tag 携带的是它自己那个包的真实版本。

**把九个 vendored 包统一到一条 `4.0.x` 版本线。** 省掉变更检测，但 cosmokit 会从 `1.8.1` 跳到 `4.0.1`、丢失上游血缘；九包内部的上游范围（`^1.8.1` 之类）会立刻失配，必须改写 vendored manifest。

**每次 vendor 发布把九包全部 patch+1，不做变更检测。** 机制最少，代价是内容与上一版逐字节相同的包也拿到新版本号。tag 把变更检测的成本压到「读一个 tag、跑一次 diff」，不值得为省这点让版本号虚涨。

**只按版本号判断「是否已发布」，不比对内容。** 参照流程根本不查 registry：publish 逐个上传，重复版本由 npm 拒绝。只按版本号跳过会漏掉「改了代码没 bump」，而这是唯一会安静地把旧字节留在 registry 上的错误。代价是引入一次 registry 查询和对构建可复现性的依赖。

**只做打包后安装验证，不起本地 registry。** 参照流程是把 tarball 解包成一棵树、用普通 Node 驱动，这绕过了版本范围解析。曾提议在 CI 里起本地 registry 补这一层，被否：产物正确性已由既有测试覆盖，发布路径由默认分支的排练覆盖，而 pull request 只需证明发布集能打出来。用 `file:` 说明符安装依然会对每个内部依赖走一遍范围解析。

**按入口闭包挑一部分包发。** 从 `@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-web-frontend` 沿 `dependencies` 爬得到 156 个包，比全量少 61 个。但本仓的插件是 `cordis.yml` 按名字挂载的、不是被 import 的：`vendor/cordis-plugin-group` 与 `vendor/cordis-plugin-logger-console` 落在依赖闭包之外，却是运行时必需。照代码依赖挑的失败形态是「消费方装完起不来」，而且要额外持续证明「没漏任何挂载项」。私有 scope 下多出来的包对组织外不可见。`python/`、`docs/` 与 `website/` 不属于 release family 成员。

**在 `scripts/publish-npm-baseline.ts` 上扩展。** 它是本机发布脚本，把 pack 与 publish 放在同一进程，与「无凭据 pack、受保护 publish」的分离相反。它验证过的零件——payload 校验与已安装产物探针——被搬运复用，以免 `pnpm run duplication` 判重复。

**一个 workflow 用 `family` 输入选择序列。** 两套版本模型塞进一个文件，会让 concurrency 组、tag 前缀、排练触发条件全部分叉成条件表达式。一族一个文件更短也更好读。

**在发布期改写依赖范围。** 与协议相比，改写逻辑只在 CI 执行过，本机 `pnpm install` 看不出它是否正确，而且每次发布都要重来一遍。

**在 CI 里执行 bump 并把版本推回仓库。** 需要给 workflow 仓库写权限，且发布分支上的版本 commit 会与人的 commit 竞争。bump 与 commit 留在本地，CI 只核对与上传。

## 后果

发布脚本是带入口守卫的可 import 模块，其判断都有单测覆盖：tag 命名、发布顺序与环报告、版本基线运算、payload 变更判据，以及各族的 payload 策略。第一版带过的两个缺陷——publish 命令在 import 时执行了 pack 命令、变更判据对 `vendor/cordis` 的源码改动失明——正是这类测试在对应接缝上能抓住的。

一个 pull request 会运行无凭据的族级排练。DSH 与 Karaka 都把打包产物装入一次性 consumer，再用普通 Node 驱动已安装 CLI 的 `--version`。这些探针证明 `files` 选出了完整 payload、发布范围可以解析，同时不混入交互行为。

代价：

- **tag 可能与 registry 漂移。** 为失败发布而推的 tag 由 bump 的 registry 核对拦下，但只在有凭据的地方；未鉴权的机器只报告这道核对被跳过。
- **变更判据依赖 tag 可见。** shallow clone 或未拉 tag 会把 vendored 族的判据退化成「全部首发」。`fetch-depth: 0` 是前提，不是优化。
- **协议改写触及 1504 处依赖声明。** 它不改变本机解析（pnpm 本来就从 workspace 解析），但改变了发布出去的范围写法。
- **私有包需要凭据才能安装。** 任何消费方——CI、沙箱 e2e、外部使用者——都要持有 scope 凭据，Landlock 三包也在其中；它们从未发布过，所以没有切断既有的匿名安装路径。
- **`repository` 指向的组织与运行 workflow 的组织不同。** 用 token 发布不受影响；npm provenance（OIDC）要求二者一致，届时要么把 `repository` 改指过去，要么从它指向的组织发布。
- **字节可复现性是假定的，没有实测。** 「integrity 相同则跳过」这一态建立在「同一 commit 两次 pack 得到相同字节」之上。目前没有任何东西测量过它：若构建嵌入了绝对路径或时间，重跑会误报失败。在第一次可能被重跑的发布之前实测，若不成立就退到比对 tarball 内逐文件内容哈希。
- **用较旧的 artifact 重跑 publish 会把 `latest` 拉回旧版。** 发布是按版本决定的，所以在较新版本之后重发较旧的一批，会让稳定 dist-tag 再次指向旧版。排练用的是预发布版本，它永远不占 `latest`。
- **首发是一次大步。** 九个 vendored 包与整个 dsh 集一次发出，任何 payload 缺陷都会集中在同一次发布里暴露——这正是先用预发布版本把完整链路走一遍的理由。
