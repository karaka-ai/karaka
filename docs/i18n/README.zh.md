# 双语文档

[English](README.md) | 中文

每份 Karaka 活动文档都包含同等权威的英文文件、简体中文文件，以及记录两侧 Git blob hash 的 `.i18n.yaml` 文件。一次改动必须同步更新两种语言，然后运行 `pnpm run docs:record`，并通过 `pnpm run docs:check` 验证。

上游 vendor 文档、legacy 语料和冻结的已归档 Agent Note 不在活动范围内。不得为了通过活动文档检查而编辑冻结记录。
