# 开发

[English](development.md) | 中文

先运行一次 `pnpm install`，开发过程中使用 `pnpm run typecheck`、`pnpm run test` 和 `pnpm run build`。`pnpm run verify` 检查完整的活动基础层，`pnpm run clean` 删除构建和打包产物。

源码阶段通过 `tsconfig.base.json` 解析 `@karaka/*` 导入。产物阶段通过已构建的 `lib/` 使用包的 exports。基础示例和包 tarball 检查覆盖产物阶段。

包发布采用手动流程。先构建并验证，再检查 `pnpm run release:pack` 生成的 tarball；只有获得明确发布授权后，才能运行 `pnpm run release:publish`。
