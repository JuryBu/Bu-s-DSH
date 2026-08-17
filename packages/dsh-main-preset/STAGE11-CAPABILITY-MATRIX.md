# Stage 11 模型与 MCP 能力链缺陷矩阵

冻结时间：2026-08-16 12:50 CST。此矩阵只描述源码与候选包可复现的状态，不把规则文字、配置存在或历史成功记录当作当前模型请求已经携带工具 Schema。

| 能力 | 冻结状态 | 已确认事实 | 本轮验收门槛 |
| --- | --- | --- | --- |
| 五个共享 MCP 的模型工具 Schema | 运行态待修复 | `stardust-main` 是每会话 Preset，五个 MCP 是 Web Profile 的宿主单例。重复写入 Preset 或 `dsh-base` 曾触发同名客户端冲突。系统提示词每个 step 都从当前 scope 的 `ctx.tools` 投影 Schema，因此缺失代表当前 Agent scope 看不到已注册工具，而不是可以用规则补救。 | 在隔离、完整 Profile 的新会话中实际记录 `request/header`，必须同时出现五个 serverName 对应的 `mcp__<serverName>__` Schema 前缀；连字符保留或规范化为下划线均可，并完成至少一个 Sandbox 调用。 |
| `read_image` 视觉门槛 | 已实现，待宿主门槛 | Windsurf Provider 与 pi-ai 请求适配均会在文本模型请求前移除视觉工具；实时目录只在明确能力位存在时标记视觉。 | 文本模型的真实 `request/header.tools` 不得含 `read_image`、`view_image`、`inspect_image`；明确视觉模型三者均可见。 |
| 模型组合目录 | 已实现，待宿主门槛 | 选择器把 GLM-5.2 的 `200K` 与 `1M` 归为同一个 family 的上下文参数；选择结果只能返回真实目录存在的变体。 | 逐一切换 DeepSeek、OpenAI、Windsurf 后，记录的 provider/model/reasoningEffort/speed/contextWindow 必须是当前目录中的同一组合。 |
| Provider 可选性 | 待真实登录后验证 | DeepSeek、ChatGPT/Codex、Windsurf 均有独立 Provider 路由；本轮不读取或使用真实凭据。 | 由隔离宿主在已授权的实际账号状态下分别完成一次模型选择和无工具短请求，失败不得回退成另一个 Provider。 |
| Ripgrep 展示与 Sandbox 优先 | 仅规则文字，展示待前端所有者处理 | `grep` 的稳定工具名和中文说明已经写明「Ripgrep」与 Sandbox 优先，但工具活动卡片的显示名称属于前端展示壳。 | UI 所有者把展示名改为「Ripgrep 搜索」，内部工具名仍为 `grep`；真实 Schema 同时含 Sandbox 后，优先级以可调用 MCP 工具为准。 |

## 不可跨越的修复边界

本包不得把 `@deepseek-ai/dsh-mcp-client` 或五个 `serverName` 复制到 `stardust-main` 或 `dsh-base`。共享客户端必须在 Web Profile 中恰好一份；候选构建和启动前置校验均把重复注册视为失败。若完整 Profile 的新会话仍看不到 MCP Schema，修复应落在 Profile 进入 Agent scope 的宿主装载链，并由拥有该加载层的主线处理。
