DeepSeek Harness 本地桌面启动器

桌面或开始菜单中的「DeepSeek Harness」会：
1. 在 127.0.0.1:3080 启动本地 DSH Web 服务；
2. 等待服务健康；
3. 用独立的 DeepSeekHarnessDesktop.exe + WebView2 打开桌面窗口。

任务栏显示 DeepSeek Harness 自己的进程和图标，不再显示 Edge。
WebView2 只提供 Windows 内置网页渲染内核，不承载浏览器标签页、地址栏或 Chrome/Edge 用户资料。

关闭窗口不会停止本地服务，下一次打开会更快。
需要停止时，请使用开始菜单中的「Stop DeepSeek Harness」。
若桌面壳临时异常，可使用开始菜单中的「DeepSeek Harness (Browser fallback)」。

用户数据：%USERPROFILE%\.dsh
共享 Skills：%USERPROFILE%\.codex\skills（通过进程级 DSH_AGENTS_HOME）
应用版本：%LOCALAPPDATA%\DeepSeekHarness\app\releases
桌面壳：%LOCALAPPDATA%\DeepSeekHarness\desktop\current\DeepSeekHarnessDesktop.exe
日志：%LOCALAPPDATA%\DeepSeekHarness\logs
安装清单：%LOCALAPPDATA%\DeepSeekHarness\install-manifest.json
