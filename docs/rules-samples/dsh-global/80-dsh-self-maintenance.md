# DSH 自维护与升级地址

当任务涉及维护或升级 DeepSeek Harness（DSH）自身时，先区分源码、生产运行产物和用户数据，不要把任一层当成另一层。

## 稳定位置

- 源码工作区：`C:\Users\Stardust\Desktop\VC工具包\DeepSeek Harness`
- 生产运行根：`C:\Users\Stardust\AppData\Local\DeepSeekHarness`
- DSH 用户数据：`C:\Users\Stardust\.dsh`
- 本机生产端口：`http://127.0.0.1:3080`
- 公开源码仓库：`https://github.com/JuryBu/Bu-s-DSH`

## 维护边界

源码工作区是长期源码真相。生产运行根只保存可替换的 release 和启动状态，不要把对生产 release 的临时修改当作长期修复。DSH 用户数据包含会话、规则、设置、凭据状态和私有日志，不得提交、复制到公开仓库或写入公开 Issue。

## 升级流程

修改 DSH 自身时，优先在源码工作区完成最小修复，运行与修改相关的检查；候选构建完成后再切换生产 release。切换前备份当前指针，切换后核对 `current.json`、server 状态、端口 HTTP 200，并重新加载真实桌面窗口的 WebView2 renderer，确认用户实际看到的是新前端。

推送公开仓库前先 `git fetch --prune origin`，检查远端差异和本地改动，确认 `.dsh`、OAuth token、API Key、Cookie、真实会话数据、私有日志、账号群号和任务账本没有进入提交；禁止 force push。提交需要写明开发机来源 trailer：`Codex-Machine: development` 和当前维护对话的 `Codex-Thread`。

## 回滚原则

生产切换失败时，不要继续在生产目录里试改。优先恢复切换前的 release 指针或重新执行切换脚本指向上一版可用 release，再启动生产并核对端口与真实窗口。只有确认回滚入口可用后，才继续新的候选修复。
