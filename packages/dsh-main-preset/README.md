# DSH 主力模式生成器

这个包不复制整份官方 `standard` 模式，而是从候选 release 中读取 DSH 0.1.0-rc.6 的标准组装文件，经过严格结构校验后生成 `stardust-main`：

- Persona 改由 `@stardust/dsh-zh-prompt-suite` 负责；
- 工作区规则读取 `AGENTS.md`、`DSH.md` 及各自的本机覆盖文件；
- 工具呈现设为 `both`，简单操作直接调用，复杂编排使用 `run_code`；
- 官方 `standard` 不修改，始终作为独立的救援和行为对照入口。

如果上游结构变化，生成器会停止并报告具体不匹配的位置，不能静默生成一半可用的模式。
