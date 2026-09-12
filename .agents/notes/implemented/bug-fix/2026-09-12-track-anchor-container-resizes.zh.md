# Agent Note: 跟踪锚点容器尺寸变化

Status: implemented

[English](2026-09-12-track-anchor-container-resizes.md) | 中文

## Problem

当触发控件在窗口 resize 事件之后移动时，固定定位的 portal 可能保留过期坐标。Schedule 目录在窗口跨过侧边栏断点变宽时暴露此问题：网格通过过渡恢复保存的侧边栏宽度，而触发控件与目录自身的尺寸保持不变。

## Decision

[`useAnchoredPosition`](../../../../packages/client/ui-primitives/src/useAnchoredPosition.ts) 在面板打开时观察面板、锚点及其祖先元素。容器尺寸变化通过现有 ResizeObserver 重新测量位置。关闭时断开该观察器并移除 scroll/resize 监听器。坐标不变时保留同一个状态值。

## Alternatives considered

**让浏览器测试等待更久。** 不采用：等待不会补上缺失的几何变化通知，而且打开的目录必须在正常使用时跟随布局变化。

**每个动画帧都测量。** 不采用：已复现的移动会改变祖先元素尺寸，ResizeObserver 能报告这些变化，无需在静止面板保持打开时持续工作。

## Consequences

面板打开时，观察器会观察更多元素。它覆盖祖先元素尺寸变化，包括动画网格轨道；不改变任何被观察元素尺寸的变换或位置变化仍不在此机制范围内。现有视口钳制、定位间距、工具行为与 golden 均保持不变。

[Schedule 浏览器用例](../../../../apps/web/tests/schedule-after.e2e.ts) 控制真实的侧边栏展开，验证触发控件移动，并在完成后比较锚点与面板的数值对齐。移除祖先观察会复现过期定位。[Hook 测试](../../../../packages/client/ui-primitives/tests/use-anchored-position.client.spec.tsx) 覆盖注册、重新测量与释放；独立的 message-feedback 浏览器用例检查另一个 portal 使用方。
