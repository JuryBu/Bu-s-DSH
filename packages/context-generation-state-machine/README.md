# DSH Context Generation State Machine

这是 DSH 自定义主力 Preset 使用的上下文代次系统。它不改写 DSH 原始会话日志，而是在独立目录生成候选上下文，完整校验后再原子切换发布指针。官方「标准模式」不加载这套插件，始终保留为救援入口。

## 当前已接入

- 自定义主力 Preset 已加载 Context Provider；官方标准、PTC、极简和创造模式保持官方实现。
- `candidate → validated → published` 三态保证只有完整候选可以替代上一代上下文。
- `bpc / hard / manual-rebuild / recovery` 四种触发来源都有明确事件和失败处理。
- BPC 阈值为 68%，硬压缩阈值为 90%，近期原文目标为 16%；界面上下文面板会显示三项状态。
- Provider 的 `maxTokens` 只是单轮输出上限，不会整块挤占输入：实际预留取较小值 `min(maxTokens, max(8192, 窗口 × 8%))`，例如 200K/131K 模型预留 16K，1M/131K 模型预留 80K。
- 工具调用与结果必须完整配对；若配对把 16% 原文尾部推过可用上限，切点会前移到下一个完整边界。Record 超预算时仅把非手动保护 Phase 依次从 `full` 降为 `summary`、再降为 `brief`，仍放不下则硬压缩暂停保护。
- BPC 失败继续使用上一代上下文，硬压缩失败暂停本次对话并保护现场，不应用半份结果。
- 先裁剪巨大工具结果，只在完整 artifact 已写完并校验哈希后用头尾预览替代中段；原始结果不会删除。
- 稳定前缀由 Memory Store Record 与少量原始轮组成，每段保留轮号、来源事件、内容哈希和展示档位。
- 热度调度以原始轮为基本单位，读取回执与明确确认分开；保护和解除保护由 DSH 原生线程工具的 sidecar 账本记录。
- `FileGenerationStore` 用候选文件、校验文件和原子发布指针持久化，进程重启后恢复最后一份已发布 generation。
- 实际请求链路已经验证 `compaction/start → compaction/summary → user/message → compaction/end`，发布失败不会移动指针。

## 外部依赖

真实 Record 由 Memory Store 只读 DSH 原始会话后发布。DSH 不写入 Memory Store，也不把 `dsh` 注册为模型链路。Memory Store 暂时不可用、Record 不完整或 generation 不匹配时，Context Provider fail closed，继续使用上一份已发布上下文。

线程原文优先走 Memory Store 的规范化缓存；只有可以确定为小型明文 JSONL 的会话才允许使用官方 `readSession()` 兜底。压缩、未知格式或超过上限的会话在 Memory Store 不可用时直接拒绝，避免大会话整体加载。

正式只读交接契约见：

- `docs/contracts/EXT-01-memory-store-handoff.md`
- `docs/contracts/dsh-memory-context-surface.v0.schema.json`
- `docs/contracts/dsh-thread-sidecar.v1.schema.json`

## 仍然保持的安全边界

- 不修改、重命名或清理 DSH 原始会话事件。
- 同一 `contextGenerationId` 内容不可变；相同 ID 出现不同哈希时拒绝。
- Record 与原始轮的 `sourceSeqs` 必须不重不漏地覆盖 `shadowedSeqs`。
- 实测 Token 加上近期原文和预留输出后不得超过模型窗口。
- 未完成 artifact、预览 artifact、哈希不符或缺少来源映射时拒绝裁剪或发布。
- 未知 manifest、sidecar schema 或操作类型一律 fail closed。
- Memory Store 只读消费上下文清单和线程 sidecar；DSH sidecar 是唯一写入方。

## 回滚

关闭自定义主力 Preset 的 Context Provider，或在会话中切回官方「标准模式」即可停止使用这套上下文管线。独立 generation 文件与 sidecar 继续保留为只读证据，不影响官方会话读取。生产发布仍通过候选目录、原子 `current.json` 和完整备份切换，可以恢复到切换前版本。
