# DSH 中文提示体系

这个包为自定义 DSH 主力 Preset 提供三项能力：

- 从 `$DSH_HOME/rules/` 按文件名稳定加载 `00-*.md` 到 `99-*.md`，并在完整读取成功后原子切换新的 Rules 文本。
- 替换该 Preset 的人格段，但不使用 DSH 原生 `complete: true`。后者会同时删除 Plan Mode、Code Mode SDK、Goal 等动态系统段，无法满足本工程已经拍板的保留要求。
- 在 `system-prompt/assemble` 的最终组装环节中文化已知系统段、动态状态和工具 Schema。未知第三方工具保留原始 Schema，并进入缺口清单，不能静默误译。

官方标准 Preset 不加载这个包，继续作为主人可手动切换的救援与行为对照入口。

当前版本是 Stage 3B 的实现骨架，尚未宣称覆盖所有官方和第三方工具。候选 release 构建时必须对真实工具目录运行“未知工具清单”和英文残留检查，补齐后才能切换生产。
