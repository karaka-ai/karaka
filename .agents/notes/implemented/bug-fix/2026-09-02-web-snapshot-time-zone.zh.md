# Agent Note: Web 快照使用统一的浏览器时区

Status: implemented

[English](2026-09-02-web-snapshot-time-zone.md) | 中文

## 问题

Web 快照页面过去会继承宿主机器的时区。用户消息会把浏览器的 IANA 时区持久化到 `clientTimeZone`，因此即使产品行为完全相同，同一次无密钥回放也会在托管 runner 与开发机器上生成不同的持久会话事件。

## 决策

共享的英文 Web 快照页面使用 `Asia/Shanghai`。显式测试时区行为的场景继续创建自己的浏览器页面，并明确指定时区。

## 曾考虑的替代方案

**从已记录事件中移除 `clientTimeZone`。** 不予采用，因为时区是请求局部行为使用的产品输入；从 fixture 中删除它会掩盖真实回归。

**继承 CI 宿主时区。** 不予采用，因为托管镜像与开发机器不保证一致。显式指定一个浏览器时区可让 fixture 跨环境使用。

## 验证

Cordis 生命周期 Web 快照无需改写 `clientTimeZone` 即可针对已提交的会话 fixture 完成回放。现有 schedule 浏览器时区场景会独立验证产品的请求局部时区行为。

## 后果

普通 Web 快照不再依赖 runner 的 locale 配置。需要其他时区的场景必须在创建页面时显式声明。
