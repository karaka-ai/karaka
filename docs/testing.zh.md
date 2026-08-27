# 测试

[English](testing.md) | 中文

基础测试位于 `tests/`。它们覆盖 Cordis 生命周期所有权、服务替换、Loader/Include 配置事务、补丁语义、精确路径 HMR 和已构建示例。

使用 `pnpm run test` 检查行为；使用 `pnpm run build && pnpm run example` 检查真实构建入口。`pnpm run release:pack` 会创建每个发布内容，将全部九个 tarball 安装到临时 NodeNext 消费者中，检查其导入类型，并运行生命周期冒烟测试。修改 `vendor/` 下的源码时，必须添加或更新证明该本地差异的回归测试。
