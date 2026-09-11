# Agent Note: The trigger menu keeps previous rows through refinement

Status: implemented

[English](2026-08-28-trigger-menu-stale-while-revalidate.md) | 中文

## Problem

在已打开的 `@`/`/` 触发菜单里,每个按键都会发起一次新的候选请求。菜单 reducer 的 `hit` 分支过去会把各组重置为 pending-空,于是列表在 100–460ms 的请求往返期间塌缩成骨架屏,每输入一个字符就重绘一次——细化查询时肉眼可见的闪烁(#3234)。

## Decision

reducer 的 `hit` 分支(`core/menu.ts`)现在保留上一次查询的行和高亮,并把各组标记为 `pending`——即 stale-while-revalidate。首次打开(`seedGroups`)仍从空开始,首帧保持骨架屏;`allReadyEmpty` 仍在结算后自动关闭。

旧行仅用于显示，并以 `aria-disabled="true"` 标记，直至所在分组就绪。`pick()` 要求候选所在组为 `ready`,`enter` 仲裁在 pick 前检查高亮组的状态:pending 窗口内 Enter 是显式 no-op(`'consumed'`)——既不选中旧行,也不落到草稿发送。Tab 的下钻早已带有相同的 `ready` 检查。

## Alternatives considered

**每次细化都清空为骨架屏。** 拒绝;这正是闪烁的现状。线上 chat 前端的会话搜索确实是清空(每次防抖查询重置结果和活动索引),其 Enter 因此天然安全——但那个列表在独立弹窗里,而本菜单直接在光标下随每个按键重绘,闪烁正是用户所报告的问题。

**pending 窗口内让 Enter 透传到发送。** 拒绝。改动前该窗口显示空骨架屏,Enter 落到发送在视觉上是自洽的;保留旧行后用户正看着一个高亮候选,此时把整条草稿发出去比几百毫秒的按键失效是更糟的误触。线上搜索在 pending 窗口的 Enter 同样是 no-op。

**把 Enter 排队,请求结算后再选中。** 拒绝。对用户尚未见到的行执行按键会重新引入选中旧数据的竞态,还额外增加时序机制。

## Consequences

细化查询时列表保持可见，请求结算后原位替换内容。pending 窗口内 Enter 被消费；稍后再次按键即可正常选取。行按 index 作为 key，因此测试操作前等待匹配的选项可用，键盘选取还要求对应的高亮。浏览器回归测试在旧文件夹行仍可见时暂停细化后的 Host 查询，验证该行不可用，再放行查询并在可用的高亮选项上验证 Enter 和 Tab。Controller 回归测试单独验证 pending 高亮下的无操作行为。细化期间已存在的高亮闪动问题仍留待后续处理。
