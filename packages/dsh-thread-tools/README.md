# DSH thread sidecar ledger

本包的线程回执、确认和保护账本不能写入官方 DSH session JSONL。`lib/sidecar-ledger.js` 提供一个独立的持久后端：它只保存线程元数据，不保存对话正文、工具结果、OAuth/API Key 或其它凭据。

## 接线边界

本实现是 durable-only backend。调用方必须显式提供绝对 `rootDir`、`ownerSessionId`、`targetSessionId`、`contextGenerationId` 和 `sourceRevision`；缺少任一绑定字段会直接失败，不会静默退回进程内内存账本。当前提交只新增 sidecar 实现和测试，没有改动 `lib/index.js`、现有 `ThreadEventLedger` 或生产 release，因此源码存在不代表 DSH 运行态已经接线。

`rootDir` 应由宿主的 session persistence 配置在运行时注入，不要写死用户目录。sidecar 文件布局为：

```text
<rootDir>/<base64url(ownerSessionId)>/<base64url(targetSessionId)>/ledger.jsonl
<rootDir>/<base64url(ownerSessionId)>/<base64url(targetSessionId)>/ledger.jsonl.lock
```

owner 和 target 只作为安全路径段编码，原始标识中的路径分隔符、绝对路径和控制字符会被拒绝；实现会再次检查最终路径仍在 `rootDir` 内。

## 最小调用示例

```js
import { SidecarThreadLedger } from "./lib/sidecar-ledger.js";

const ledger = await SidecarThreadLedger.open({
  rootDir: hostConfig.threadLedgerRoot,
  ownerSessionId: ownerSession.id,
  targetSessionId: readResult.sessionId,
  contextGenerationId: contextBuilder.generationId,
  sourceRevision: readResult.sourceRevision,
});

await ledger.initialize({ operationId: "stable-init-operation-id" });
const receipt = await ledger.registerReceipt({
  operationId: "stable-read-operation-id",
  readReceiptId: "read-receipt-id",
  snapshotId: readResult.snapshotId,
  dataSource: readResult.dataSource,
  rounds: readResult.rounds.map(round => round.round),
});
await ledger.confirmReceipt({
  operationId: "stable-confirm-operation-id",
  readReceiptId: receipt.readReceiptId,
  rounds: [1, 2],
});
await ledger.protect({
  operationId: "stable-protect-operation-id",
  protectionId: "protection-id",
  ranges: [{ start: 3, end: 5 }],
});
```

代次或 source revision 变化时，调用方必须用 `rotateGeneration` 明确提交前一绑定；旧回执和保护随后会因 `ledger_stale_generation` 或 `ledger_stale_source_revision` 被拒绝。旧记录保留在链上，不能被新代次同名覆盖。

## 持久化协议

每条 newline-terminated JSON 记录包含 `schemaVersion`、`seq`、`prevHash`、`hash`、`operationId`、操作类型、owner/target、上下文代次、source revision 和最小元数据 payload。`hash` 是当前记录（不含自身 hash）的 SHA-256，`prevHash` 串成 append-only hash chain；`operationId` 的相同请求返回第一次提交结果，使用同一 ID 提交不同请求会失败。

超大单轮的 partial 片段使用 `source.unit="utf8-byte"`，`startOffset` 与 `endOffset` 是该 block 内实际交付内容的 UTF-8 字节范围，`contentHash` 是完整 block 内容哈希。续读游标同时保存轮号、block、下一字节偏移、内容哈希和来源版本；缺少这些字段或版本变化时必须重新开始读取，不能把片段回执扩大成整轮回执。

写入时先取得进程内队列和独占 `.lock` 文件，再记录旧字节偏移，追加完整行并调用 `FileHandle.sync()`。写入或同步失败会截断回旧偏移并再次同步；回滚失败会把账本标记为损坏并拒绝继续写入。锁文件不会按猜测的 TTL 静默删除，遇到其它进程持锁直接返回错误。

恢复只接受完整、连续、哈希正确且 schema 已知的前缀。文件末尾唯一一段没有换行的字节会被视为最终 torn line，下一次追加前截断到最后一个完整换行；中间坏行、完整行 JSON 损坏、未知 schema、seq 缺口、owner/target 错配或 hash mismatch 都 fail-closed。sidecar 错误不会改写官方 session 文件，也不会自动切换到官方 `session.append` 或 volatile fallback。

Memory Store 在本方案中仍只承担线程读取来源，sidecar 不调用其写接口，也不把账本事件注入 Memory Store Record。

## 定向验证

在本包目录执行：

```powershell
node --test tests/sidecar-ledger.test.mjs
npm.cmd test
```

测试使用临时目录和合成标识，覆盖重启重放、receipt/protection 陈旧拒绝、operationId 幂等与冲突、完整行哈希损坏、未知 schema、中间坏行、最终 torn line 修复、路径边界、持久化失败不降级，以及官方 session fixture 字节不变。没有读取 `%USERPROFILE%\.dsh`、真实 session、凭据或生产 release，也没有执行真实授权或生产接线。
