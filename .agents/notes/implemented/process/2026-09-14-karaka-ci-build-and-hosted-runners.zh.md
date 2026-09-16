# Agent Note: Karaka CI 构建归属与托管运行器

Status: implemented

[English](2026-09-14-karaka-ci-build-and-hosted-runners.md) | 中文

## Problem

组织专用运行器标签使 Karaka 拉取请求持续排队，无法分配运行器。通用 DSH 打包器还会发现由独立构建生成 JavaScript 的 Karaka 包，导致发布、预览、基准测试和 Python 可执行文件作业在测试前失败。强制要求尚未配置的 API 密钥，也会阻塞能够执行全部无密钥检查的仓库。

## Decision

独立构建决策由 [Karaka 工作区规范一致性](2026-09-14-karaka-workspace-conformance.zh.md)取代，后者负责编译器与打包器集成。

[拉取请求 CI](../../../../.github/workflows/ci.yml)默认使用 `ubuntu-24.04` 和 `windows-2025`。标准 GitHub 运行器使用较低的门禁、覆盖率和快照并发度。配置相应运行器池后，仍可使用[平台故障切换开关](2026-07-26-ci-failover-runbook.zh.md)和 [Blacksmith 覆盖配置](2026-09-09-blacksmith-failover-leg.zh.md)。

[真实 API 工作流](../../../../.github/workflows/e2e.yml)通过通知与作业摘要报告凭证缺失，然后跳过测试作业。[Python wheel 包 CI](../../../../.github/workflows/build-exe-for-python-sdk.yml)仅跳过真实 API 步骤。配置密钥后，现有测试会启用，测试失败仍会使 CI 失败。[API 安全决策](../testing/2026-06-19-real-api-e2e-ci.zh.md)继续负责可信事件与密钥暴露策略。

[预览工作流](../../../../.github/workflows/build-preview-cloudflare.yml)始终构建产物；部署、受保护镜像验证与 URL 评论要求四项 Cloudflare 凭证全部存在。缺少凭证时产生通知与摘要。

[CI 进程跟踪器](../../../../scripts/run-gates.ts)对每个可达 PID 仅访问一次，并从后代列表中排除根进程。遍历队列独立于记录的父子关系行，子进程逐个加入队列。循环或重复的进程表关系不会使队列无限增长；宽进程表不依赖 JavaScript 参数数量上限。这限制了枚举工作量，不改变进程归属或终止策略。

## Alternatives considered

**通过上游图编译 Karaka：**这会重复现有源码构建的职责，还需整合应用专用的浏览器与声明入口。[工作区规范一致性](2026-09-14-karaka-workspace-conformance.zh.md)取代了这一归属选择。

**所有仓库均强制要求自定义运行器和凭证：**这会使常规验证依赖仓库可能并不具备的基础设施。显式覆盖配置与可见的真实测试跳过状态，保留了覆盖不可用与测试通过之间的区别。

## Consequences

标准运行器可能耗时更长，但作业无需注册自定义运行器池即可调度。缺少凭证意味着没有真实 API 覆盖；作业跳过不能证明提供方行为正确。无密钥检查仍为必需。工作流测试使用隔离的输出文件和合成密钥执行凭证脚本；执行 Windows 脚本需要 PowerShell。
