# Bu's DeepSeek Harness

这是 DeepSeek Harness 的本地增强工作区，用于把功能补丁、测试和候选版本构建过程做成可重复执行的源码工程。

当前公开内容包括：

- DeepSeek Harness 桌面壳源码；
- 模型、上下文、线程、消息分支、工具展示与 Provider 增强包；
- 从干净上游 release 生成候选版本的构建与校验脚本；
- 对应的单元测试和回归测试。

## 隐私边界

仓库不包含本机 DSH 数据目录、OAuth 凭据、会话内容、运行日志、构建候选、协作任务记录或验收截图。候选版本需要在本机基于已经安装的干净 DeepSeek Harness release 重新生成。

## 环境

- Windows 10/11
- Node.js 22+
- npm 11+
- .NET 8 SDK（仅构建桌面壳时需要）

默认上游基线位置：

```text
%LOCALAPPDATA%\DeepSeekHarness\app\releases\0.1.0-rc.6-oauth
```

也可以在构建时通过 `--source` 显式指定其它已核验的干净基线。

## 安装依赖与测试

```powershell
npm ci
npm run test:packages
npm run build:desktop
```

## 构建候选版本

```powershell
node scripts/Build-CandidateRelease.mjs --name my-candidate
node scripts/Verify-CandidateRelease.mjs --candidate my-candidate
```

候选输出到 `release/candidates/`，该目录默认不进入 Git。

## 生产切换

生产切换脚本会先校验候选、停止受管服务、保存当前 release 指针并生成回滚备份，再安装候选：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/Switch-ProductionRelease.ps1 -CandidateName my-candidate
```

脚本只更新 release 指针；切换后仍需使用本机安装目录中的启动器启动服务，并核对 HTTP、进程命令行和运行状态文件。生产操作前请先保留当前可用版本和回滚路径。
