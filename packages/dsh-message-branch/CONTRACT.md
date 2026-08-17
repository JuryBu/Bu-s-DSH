# DSH 上一条用户消息编辑并重发契约

## 适用边界

本插件只允许在源 Agent 真实空闲且 inbox 没有待处理输入时，编辑该会话最后一条 `source.kind=user` 的真人消息。插件不会改写源会话，而是创建新分支；源会话及其日志始终保持原样。

## 状态机

一次操作由调用方提供稳定 `operationId`，状态只能按下列方向变化：

```text
不存在 -> preparing -> created
                  \-> failed
```

- `preparing`：已锁定源会话、分支点、附件与内部回放参与者，尚未发布子会话。
- `created`：子会话已发布、工作区已附着、编辑后的消息已被子 Agent 接纳。
- `failed`：本次操作未成功建立可用分支；若子会话曾短暂创建，插件必须先销毁并从工作区解绑。

相同 `operationId` 和相同请求可以幂等返回既有 `created` 结果；请求内容不同则返回 `operation_conflict`，不得复用旧结果。

## 分支点

1. 在源会话事件中找到最后一条 `user/message` 且 `event.data.source.kind === "user"` 的事件。
2. 找到包围该消息的最近一个 `turn/start`。
3. 新分支只继承该 `turn/start` 之前的完整稳定前缀。
4. 编辑后的消息通过新 Agent 的 `followup()` 进入新分支，因此新分支恢复的是“该条编辑消息刚发送后”的 DSH 内部状态，而不是复用旧回复。

## 可回滚与不可回滚状态

DSH 内部、明确实现回放契约的系统工具可以注册回放参与者：

- `capture()` 在源 Agent 的 maintenance 锁内读取分支点状态。
- `restore()` 只在尚未发布的子 Agent scope 内恢复状态。
- 任一恢复失败都会阻止子 Agent 发布；已经注册到子 scope 的状态随 scope 销毁回滚。

Sandbox、MCP、外部 API、真实文件、网络请求、第三方账户等副作用不会因分支而撤销。每个分支都必须注入以下事实，且不得声称外部修改已经回滚：

> 本会话由编辑上一条用户消息创建分支。DSH 内部可重放状态已恢复到分支点；Sandbox、MCP、外部 API、真实文件、网络请求等外部副作用没有撤销，仍可能存在。不得声称它们已回滚；继续操作前如相关应重新核对。

## 请求格式

```json
{
  "operationId": "frontend-generated-id",
  "sessionId": "source-session-id",
  "expectedSourceMessageId": "message-id-currently-shown-by-editor",
  "modelSelection": {
    "provider": "provider-selected-by-current-composer",
    "model": "model-selected-by-current-composer",
    "reasoningEffort": "optional-current-composer-effort"
  },
  "draft": {
    "text": "edited text",
    "images": [
      { "attachment": { "attachmentId": "...", "mediaType": "image/png", "bytes": 1, "width": 1, "height": 1 } },
      { "dataBase64": "...", "mediaType": "image/png", "name": "image.png" }
    ],
    "files": [
      { "name": "report.pdf", "mediaType": "application/pdf", "bytes": 12, "workspacePath": "C:\\\\project\\\\report.pdf" },
      { "name": "archive.zip", "attachmentRef": "host-upload-ref" }
    ],
    "order": [
      { "type": "text" },
      { "type": "image", "index": 0 },
      { "type": "file", "index": 0 }
    ]
  }
}
```

- 草稿至少包含非空文本、图片或文件之一。
- `modelSelection` 是可选的发送时选择；提供时必须包含非空 `provider` 与 `model`，可选 `reasoningEffort` 也必须非空。插件在子 Agent setup 中使用 DSH 官方 `installModelSelection()` 同时覆盖提示词变量与实际 `agent/request`，因此编辑重发不会继承源会话的旧模型上下文；省略它的旧调用保持原行为。
- 图片使用 DSH 官方持久附件引用；内联图片必须先通过官方附件服务校验并保存。
- DSH rc.6 没有通用文件内容块。文件由宿主先保存到当前工作区并传 `workspacePath`，或传稳定 `attachmentRef`；插件把文件清单作为明确文本内容送入模型，不伪造文件字节已经进入 DSH 图片附件库。
- `draft.order` 是兼容扩展，前端应按用户正在编辑的原始块顺序传 `{type:"text"}`、`{type:"image",index}`、`{type:"file",index}`；旧客户端省略时，后端按源消息内容顺序兜底。
- `workspacePath` 必须是绝对路径且位于源会话工作区内。

## 持久事件与前端契约

插件通过 `message-branch/state` 发布完整状态快照，前端按 `operationId` 覆盖旧快照。固定字段：

```json
{
  "schemaVersion": 1,
  "operationId": "...",
  "state": "preparing|created|failed",
  "parentSessionId": "...",
  "sourceMessageId": "...",
  "sourceEventSeq": 12,
  "sourceTurn": 3,
  "branchPointSeq": 10,
  "childSessionId": "...",
  "editedMessageId": "...",
  "participantIds": ["todo"],
  "attachments": { "images": [], "files": [] },
  "modelSelection": { "provider": "...", "model": "...", "reasoningEffort": "..." },
  "externalEffects": "preserved",
  "requestDigest": "sha256:...",
  "createdAt": "...",
  "updatedAt": "...",
  "failure": { "code": "...", "message": "..." }
}
```

状态 sidecar 不保存用户文本、图片字节、Token 或回放快照，只保存请求摘要、目标模型选择、分支定位、附件元数据和失败边界。目标模型选择参与请求摘要，因此相同 `operationId` 改用另一模型会稳定返回 `operation_conflict`。

前端流程固定为：

1. 调用 `availability(sessionId)`，只有 `allowed=true` 才显示编辑入口。
2. 编辑器回填 `draft.text`、持久图片引用和插件 sidecar 中可恢复的文件描述。
3. 调用 `editAndResend(request)`。
4. 收到 `created` 后导航到 `childSessionId`；源会话继续保留。
5. `failed` 时留在源会话并展示稳定错误码，不猜测外部副作用是否撤销。
