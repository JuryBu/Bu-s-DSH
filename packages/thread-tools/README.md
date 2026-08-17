# DSH 原生线程只读底座候选包

这是一个**候选包**，用于冻结 `thread_list`、`thread_search` 和 `thread_read` 的宿主适配边界与测试行为。它不读取任何真实 DSH 会话目录，不会扫描用户目录，也不连接 Memory Store。

## 默认路径：复用 rc.6 宿主能力

`Rc6ThreadToolsHostAdapter` 不创建第二套生产索引。它要求宿主把官方包封装为三个 seam：

| 宿主能力 | 本包使用方式 | 本包不做的事 |
|---|---|---|
| `@deepseek-ai/dsh-session-persistence-jsonl` | 只读 header、按已选块调用 `readFrom` | 不自行解码生产 JSONL、Zstandard frame 或 torn tail |
| `@deepseek-ai/dsh-session-query` / SQLite | 直接委托稳定搜索游标与 snippet | 不维护并行 SQLite 搜索索引 |
| `session-projection-cache` | 取得已 live/persisted reconcile 的稳定快照和轮定位 | 不绕开投影缓存拼装另一份有效历史 |

这里的 seam 是**适配器行为契约**，不是对 rc.6 实际导出函数签名的断言。接入时应由 DSH 宿主插件把现有 API 映射进 `Rc6ThreadHostSeams`，并在目标 rc.6 安装包上做一次集成测试。

读取先从投影缓存取得轮号、底层块偏移和保守的序列化字节/Token 估算，再决定预算内页；正式路径只保留这一小页的 locator 与轮次。若完整结果超预算，则按相邻源块调用官方 `readFrom`，边解码边写入宿主 `ThreadArtifactWriter`，不要求构造全部剩余轮次数组或巨大字符串。若已经有可内联轮次则同时返回稳定 `continuationCursor`，cursor 锚定不可变 `snapshotId`，续页从绝对 locator 位置继续，不重读前页。

正式适配器必须显式注入宿主管理的流式 `ThreadArtifactStore`。`InMemoryThreadArtifactStore` 会在测试进程中保存 chunk，只允许 fixture 和隔离测试使用，不是生产大对话 artifact 实现。

## 兼容回退：只限 fixture 与隔离验证

`FixtureThreadHost` 与 `IncrementalFixtureThreadIndex` 只接受调用方显式传入的 `AppendOnlyByteSource`，不会发现路径或自动读取会话。它们用于合成 fixture、隔离兼容测试和未来的严格回退：

- 只接受 `formatVersion: 0`，未知版本直接 fail-closed。
- JSONL 维护 committed-prefix、轮索引和块偏移；torn tail 在补全换行前不发布。
- packed rows 支持对象行或带 `columns` 的位置行。
- 生产代码不新增 Zstandard 依赖，必须注入经过宿主验证的 decoder。测试 fixture 使用 Node 内置实现生成真实、连续的 Zstandard frame；“synthetic”只指内容为合成数据，测试 decoder 通过登记的压缩帧长度严格区分完整帧与截断尾。
- 每次 append 只从上次 committed/pending offset 增量扫描，指定轮读取只走已索引范围；不会每次完整重解析。

这一回退实现的稳定 cursor 仅在同一 host 进程保留其快照时可继续使用。生产 cursor 的持久化与跨进程恢复应由官方 query/projection seam 负责。

## 写侧冻结，不在本包执行

`ThreadMarkUsefulRequest`、`ThreadProtectRequest` 与 `ThreadReleaseProtectionRequest` 只提供 TypeScript 接口和事件草案，没有执行函数、热度、权重或配额参数。内部事件草案可记录 `readReceiptId` 与 `contextGenerationId`，但 `thread_mark_useful` 不要求模型传回回执。

运行验证使用 Node 24 自带的 TypeScript type stripping：

```powershell
Set-Location 'packages/thread-tools'
npm test
```
