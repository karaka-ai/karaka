# Agent Note: 可选凭据不阻塞必需 CI

Status: implemented

[English](2026-09-02-optional-ci-credentials.md) | 中文

## Problem

必需的拉取请求与主分支检查必须证明 Karaka 能从干净 checkout 构建，并且确定性行为正常。若这些检查必须提供 DeepSeek API 密钥，仓库配置、提供方可用性或账户余额就会阻塞无关的源码变更。同样，若 issue project 的簿记必须提供 GitHub App 凭据，尚未安装该应用时，可选的仓库自动化也会失败。

存在凭据时，live 提供方测试与 issue project 更新仍有价值，但二者都不是源码构建本身通过所需的证据。

## Decision

`DEEPSEEK_API_KEY_EXTERNAL` 为空时，DeepSeek e2e 工作流会报告 notice，并跳过其带凭据的构建与套件；必需的干净构建和确定性测试仍由 keyless CI 工作流负责。配置该凭据后，e2e 工作流只会在 live 测试步骤中映射 secret。安装后 Python wheel 工作流会在每个必需目标上运行全部确定性的打包运行时场景，并且只在同一 secret 非空时运行 live DeepSeek 场景。因此，缺少提供方凭据只会跳过 live 提供方证据，不会使必需的 keyless 证据失败。

Issue lifecycle 工作流会在创建 installation token 或修改已配置 project 前，检测两个 GitHub App 凭据值是否同时存在。缺少凭据时，它会报告 notice，并在不修改 project 的情况下成功结束。Cloudflare 预览工作流同样会报告 notice，并且只有在 4 个部署与 Access 凭据全部存在时才执行 checkout、构建、部署、验证和评论。独立的 issue policy 工作流仍是使用工作流 token 的只读必需检查。它会从默认分支 checkout policy 代码，再仅用可信的事件元数据设置 organization 与 repository 字段，然后执行验证；其他 policy 设置仍由默认分支负责。

在可行处，secret 仍限定在步骤范围内，且绝不暴露给 fork 或 Dependabot 拉取请求。工作流继续使用 `pull_request`，绝不使用 `pull_request_target`。发布不属于本决策：显式 registry 发布仍需要 registry 授权或已配置的 trusted publishing。

## Alternatives considered

**可选凭据缺失时让每个可信运行失败。** 否决：这会让干净构建与确定性测试结果依赖仓库管理和外部账户。绿色 keyless 运行并不声称已经执行 live 提供方行为；被跳过的步骤与套件会保留这一区别。

**移除 live 提供方与 project 自动化路径。** 否决：已配置的仓库仍可从提供方兼容性检查与 project 同步中受益。

**向 fork 拉取请求暴露 secret。** 否决：不可信代码可以窃取这些 secret。在不可信 ref 上缺少 live 信号，比授予凭据更安全。

## Consequences

没有 DeepSeek 密钥、issue GitHub App 或 Cloudflare 凭据的仓库仍能运行全部必需的干净构建与确定性检查，而不会出现凭据失败。其 CI 要等到配置对应的可选凭据后，才会证明 live 提供方兼容性、更新 issue project 或发布预览。工作流 UI 会通过跳过带凭据的工作或显式 notice 展示这些缺失，而不是把它们当作源码失败。
