# DSH Context Status UI

这是一个默认关闭的上下文状态显示插件，只提供 `conversation.input.right` 的只读展示，不改变压缩策略、会话事件或模型请求。

## 展示内容

- `BPC 预压缩 68%` 与 `硬压缩 90%` 两个固定阈值。
- 状态源实际给出的当前 Token、窗口上限和占用比例。
- 中文压缩阶段说明，以及可展开的状态详情。
- 不包含手工 Pin、选轮、保护预算或阈值滑块。

状态源不可用时，插件不挂载。状态源存在但缺少完整 token 计量时，界面明确显示「当前 Token/窗口占用：暂不可用」，不会用零值或估算值补齐。

## 宿主接线

宿主应先通过 Cordis 服务提供两个对象：

1. `contextStatusSource`：实现 `getSnapshot()`，可选实现 `subscribe(listener)`；快照至少在有真实计量时给出 `currentTokens` 和 `contextWindowTokens`。
2. `conversation.input.right`：实现 `mount(slot, renderer)`，并使用 `renderer.getPresentation()`、`renderer.subscribe()` 与 `renderer.toggleExpanded()` 渲染输入框右侧状态组件。

随后以 `{ enabled: true }` 挂载本包的 `apply` 入口。应只在主力模式的已验证宿主组合中启用，标准模式保持不加载；插件通过 `CONVERSATION_INPUT_RIGHT_SLOT` 常量传入精确挂载点，不依赖用户 profile、私有会话或凭据文件。

## 验证

在本包目录执行：

```powershell
npm.cmd test
```
