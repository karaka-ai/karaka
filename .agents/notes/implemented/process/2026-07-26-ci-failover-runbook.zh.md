# Agent Note: CI 故障切换手册 — 托管池 → 自有池

Status: implemented

[English](2026-07-26-ci-failover-runbook.md) | 中文

## 问题

[CI](../../../../.github/workflows/ci.yml) 中必需的 Linux 工作作业与原生 Windows 作业使用 GitHub 标准托管运行器。某个平台的托管容量发生故障时，该平台上的所有必需作业可能同时排队或失败，而合并工作流修复也可能被这些检查阻塞。**适用范围：两个独立开关，每个平台一个。**`DSH_CI_FAILOVER_LINUX` 恢复 3 个 Linux 工作作业与 `all checks passed` 的标准 Linux 池故障；`DSH_CI_FAILOVER_WINDOWS` 恢复 4 个原生 Windows 作业的标准 Windows 池故障。因此，故障恢复需要一个具备仓库写权限的响应者无需合并即可切换的开关。

## 决策

每个 Linux 工作作业、原生 Windows 作业与 `all checks passed` 判定作业都通过平台专用的仓库变量解析运行器。变量不存在时，作业使用 `ubuntu-latest` 或 `windows-2025`。变量设为 `selfhosted` 时，来自可信同仓库且不是 Dependabot 的分支会使用 `vm-backup` 或 `dsh-win-ci`；fork 与 Dependabot 拉取请求仍使用标准托管运行器。Linux 故障切换会跳过托管 pnpm 缓存恢复，因为持久虚拟机拥有热 store。两种拓扑使用同一套降低后的 worker 预算。master 上的热备通道会继续在自托管池中执行完整的未分片聚合流程。

`ci-master.yml` 只豁免一个事件不做取消（`${{ github.event_name != 'push' }}`），因此一次 master 推送不会取消上一次推送留下的、仍在运行的演练。每次演练以单门禁工作进程执行完整的未分片聚合流程，耗时长于 master 合并的间隔；在无条件取消下，演练会在得出结论前被后续运行取代，该通道无法产出供响应者查看的就绪证据。

这项豁免比「演练总能跑完」要窄，有两点限制。其一，GitHub 每个组只保留一个待运行条目，更新的待运行条目会顶掉更早的，繁忙时段中间的推送运行仍会以 `cancelled` 结束。其二，该表达式是针对**新触发的运行**求值的，因此自身事件不是 `push` 的运行——例如在 `ci-master.yml` 内的 master 上派发的基准测试，与其演练共用 `CI master-<ref>` 组——求值为 `true`，会取消正在运行中的演练。这属于罕见的手动操作，且下一次 master 推送即可恢复证据，因此不值得为它再加机制。这项豁免换来的是该通道**周期性**地得出结论，而这正是它能作为证据的前提。

这个决定必须放在工作流级：取消作用于被取代的整个运行，作业级 `concurrency` 组并不能豁免其所属作业。采用否定式写法而非仅指名 `pull_request`，是有实质作用的：后者会连 `workflow_dispatch` 一起停止取消，而每次运行器基准测试会在 master 上的同一并发组内同时占用 12 台大规格运行器、最长 15 分钟，届时重复派发会排在演练之前，而不是替换掉已过时的测量。成本之所以可控，是因为 `ci-master.yml` 中一次 master 推送只承载 `wine-apt-cache` 和这两条演练；拉取请求作业位于独立的 `ci.yml`（不监听 `push`），而基准测试在 `ci-master.yml` 内受 `workflow_dispatch` 门控。`scripts/ci-workflow.spec.ts` 会锁定这个推送可达集合——按条件精确匹配，因为否定式事件判断会包含它所排除的事件名——使新的推送可达作业无法悄悄开始累积未取消的运行。

### 自有池是什么

`vm-backup`：一台 64 核虚拟机，6 个常驻 systemd 管理的运行器实例。其镜像必须预装 Playwright Chromium 的 Linux 系统软件包；CI 会下载锁文件选定的浏览器，但绝不在这台持久化共享主机上运行 `apt`。切换前先看 `serial / linux (self-hosted standby)` 最近一次运行：其聚合流程包含浏览器回放，因此绿色热备同时验证常规容量和这项浏览器先决条件。

#### Windows 池

`dsh-win-ci`：公司内部 Windows CI 服务器（一台 96 核 / 580 GB 机器）上 32 个常驻运行器实例（计划任务 `GH-Runner-01`…`GH-Runner-32`）。标签：`[self-hosted, dsh-win-ci, windows]`。镜像必须预装 Node 24、pnpm、Git（Git Bash 在 `PATH` 上，即 `C:\Program Files\Git\bin`——`bash` 工具按名称 spawn `bash`）、PowerShell 7，并为符号链接支持启用开发人员模式。切换前先看 `serial / windows (self-hosted standby)` 最近一次运行：绿色热备验证该池能端到端执行 `check:ci:windows-complete`。

### 切换步骤（任何具备写权限的协作者，约 1 分钟，无需合并）

两个开关相互独立：只切换发生故障的那个平台。

1. 仓库 **Settings → Secrets and variables → Actions → Variables → New repository variable**：名称 `DSH_CI_FAILOVER_LINUX`（Linux 池故障）或 `DSH_CI_FAILOVER_WINDOWS`（Windows 池故障），值 `selfhosted`。
2. 重新触发必需作业，使其重新解析运行器池。已经为托管标签**排队**的作业不会重定向，也无法原地 re-run，因此对于本手册所述的无限排队故障，应取消卡住的运行并 re-run all jobs，或推送一个新提交；“Re-run failed jobs”只有在作业真正失败（而非仍在排队）时才有用。
3. 切换到此完成。Linux 故障切换会跳过托管路径的 pnpm 缓存恢复，因为虚拟机的持久 store 会提供热安装。两个 Linux 池都使用 2 个单 worker 插桩覆盖率分区、1 个豁免重型 worker 和相同的快照限制。Windows 开关只会重定向原生 Windows 作业。

#**不可信拉取请求例外。**两个开关都会排除 Dependabot，并要求 `github.event.pull_request.head.repo.full_name == github.repository`。因此，依赖更新与 fork 拉取请求会留在临时标准运行器上，而不会在持久虚拟机中执行其提供的代码。

**谁能扳动这个变量。**GitHub 的 API 允许具有写权限的协作者管理仓库变量，因此每个开关实际是写者级而非严格的管理员级。同仓库选择器把自托管执行限定为由仓库写者控制的分支；变量只会路由这些可信工作。

## 切换期间的容量

6 个常驻实例可承接正常 PR 流量（该池平时唯一的稳态负载是每次 master 推送一个串行热备作业，故障切换时几乎全池可用）。若仍出现排队，用组织级注册 token（组织 Settings → Actions → Runners → New runner）追加注册实例。复制现有 runner 目录时**必须排除身份文件**——`rsync -a --exclude '.runner*' --exclude '.credentials*' --exclude '_diag' --exclude '_work' <src>/ <dst>/`（通配同时排除 `.runner_migrated`/`.credentials_migrated`——GitHub 会在迁移过的运行器上写入这些文件，它们同样会触发 already-configured 拒绝）——再跑 `config.sh`（原样拷贝 `.runner`/`.credentials` 会使其以 "already configured" 拒绝），然后**启动监听器**：`sudo ./svc.sh install ubuntu && sudo ./svc.sh start`。仅注册不会上线；只有启动了服务的 runner 才会增加容量。每个约一分钟。


### 切回

删除 `DSH_CI_FAILOVER_LINUX` 或 `DSH_CI_FAILOVER_WINDOWS` 变量，或改为 `selfhosted` 以外的任何值，新的运行即解析回 GitHub 标准托管池。若故障期间追加注册过实例，将其移除。

### 信任边界

这些变量是写者可管理的仓库状态；`pull_request` 事件本身不能设置它们。拉取请求运行会执行 merge ref 中的工作流定义，因此运行器选择器还会在选择持久运行器前要求同仓库 head 并排除 Dependabot。fork 与依赖提供的工作流始终使用临时标准容量。runner group policy 可以进一步限制自托管池，但必须允许故障切换所要执行的同仓库拉取请求工作流。

## 曾考虑的替代方案

**通过合并一次工作流改动来切换池。** 否决，因为触发切换的故障状态恰恰是任何 PR 都无法合并的状态：必需检查正是失败的那些。仓库变量是写者可管理的状态，重跑即生效，无需合并。

**让自托管池长期处于必需路径中。** 否决，因为这是拿托管池的可用性去换自有虚拟机的可用性，只是搬移了单点故障而非增加回退。这些变量让托管池保持主路径，自托管池作为一个经过验证、一步即可启用的热备；按平台拆分意味着一个平台的故障不会重定向另一个平台。

## 后果

从托管池故障中恢复只需切换受影响平台的变量并重跑，关键路径上无需合并。代价是每个平台都要维护第二套运行器拓扑：master 上的热备通道会执行它，而 Linux 缓存恢复分支必须与其托管分支保持一致。按平台拆分会把每个开关限制在一个平台内，同仓库保护条件则阻止这条恢复路径接纳 fork 代码。
