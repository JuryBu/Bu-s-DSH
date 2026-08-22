using System.Diagnostics;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Net;
using System.Text.RegularExpressions;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace DeepSeekHarnessDesktop;

internal static class Program
{
    private const string MutexName = "Local\\DeepSeekHarnessDesktop.Singleton";
    private const string ActivateEventName = "Local\\DeepSeekHarnessDesktop.Activate";

    [STAThread]
    private static void Main()
    {
        using var mutex = new Mutex(true, MutexName, out var isFirstInstance);
        if (!isFirstInstance)
        {
            try
            {
                using var activateEvent = EventWaitHandle.OpenExisting(ActivateEventName);
                activateEvent.Set();
            }
            catch (WaitHandleCannotBeOpenedException)
            {
            }

            return;
        }

        ApplicationConfiguration.Initialize();
        using var activationEvent = new EventWaitHandle(false, EventResetMode.AutoReset, ActivateEventName);
        using var window = new HarnessWindow();

        var activationThread = new Thread(() =>
        {
            while (!window.IsDisposed)
            {
                activationEvent.WaitOne();
                if (window.IsDisposed)
                {
                    return;
                }

                try
                {
                    window.BeginInvoke(window.RestoreAndActivate);
                }
                catch (InvalidOperationException)
                {
                    return;
                }
            }
        })
        {
            IsBackground = true,
            Name = "DeepSeek Harness activation listener"
        };
        activationThread.Start();

        Application.Run(window);
    }
}

internal sealed class HarnessWindow : Form
{
    private const int DesktopTitlebarHeight = 36;
    private const int ResizeGripSize = 8;
    private const int WmNcLeftButtonDown = 0x00A1;
    private const int WmNcHitTest = 0x0084;
    private const int HtClient = 1;
    private const int HtCaption = 2;
    private const int HtLeft = 10;
    private const int HtRight = 11;
    private const int HtTop = 12;
    private const int HtTopLeft = 13;
    private const int HtTopRight = 14;
    private const int HtBottom = 15;
    private const int HtBottomLeft = 16;
    private const int HtBottomRight = 17;
    private const int DirectoryEntryLimit = 500;
    private const int FileReadMaxLines = 500;
    private const int FileReadMaxBytes = 262144;
    private const int FileWriteMaxChars = 1048576;
    private const int TerminalCommandMaxChars = 4000;
    private const int TerminalOutputLimit = 65536;
    private const int TerminalTimeoutMs = 20000;
    private static readonly Uri HarnessUri = ResolveHarnessUri();
    private static readonly string[] IgnoredDirectoryNames = [".git", "node_modules", ".dsh", ".codex-tmp"];
    private readonly WebView2 webView;
    private readonly WebView2 embeddedBrowser;
    private readonly Panel loadingPanel;
    private readonly Label statusLabel;
    private readonly Button retryButton;
    private readonly HttpClient httpClient = new() { Timeout = TimeSpan.FromSeconds(3) };
    private readonly bool customTitlebarEnabled = IsCustomTitlebarEnabled();
    private readonly string workspaceRoot = ResolveWorkspaceRoot();
    private CoreWebView2Environment? webViewEnvironment;
    private bool startupRunning;

    [DllImport("user32.dll")]
    private static extern bool ReleaseCapture();

    [DllImport("user32.dll")]
    private static extern IntPtr SendMessage(IntPtr hWnd, int message, IntPtr wParam, IntPtr lParam);

    public HarnessWindow()
    {
        Text = "DeepSeek Harness";
        StartPosition = FormStartPosition.CenterScreen;
        WindowState = FormWindowState.Maximized;
        MinimumSize = new Size(1024, 700);
        BackColor = Color.FromArgb(20, 20, 22);
        Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
        if (customTitlebarEnabled)
        {
            FormBorderStyle = FormBorderStyle.None;
        }

        webView = new WebView2
        {
            Dock = DockStyle.Fill,
            DefaultBackgroundColor = Color.FromArgb(20, 20, 22)
        };

        embeddedBrowser = new WebView2
        {
            Visible = false,
            DefaultBackgroundColor = Color.White
        };

        statusLabel = new Label
        {
            AutoSize = true,
            ForeColor = Color.FromArgb(220, 220, 224),
            Font = new Font("Microsoft YaHei UI", 12F, FontStyle.Regular),
            Text = "正在启动 DeepSeek Harness…",
            Anchor = AnchorStyles.None
        };

        retryButton = new Button
        {
            AutoSize = true,
            Text = "重试",
            Visible = false,
            FlatStyle = FlatStyle.Flat,
            ForeColor = Color.White,
            BackColor = Color.FromArgb(62, 106, 229),
            Padding = new Padding(18, 6, 18, 6),
            Anchor = AnchorStyles.None
        };
        retryButton.FlatAppearance.BorderSize = 0;
        retryButton.Click += async (_, _) => await StartAsync();

        var loadingStack = new FlowLayoutPanel
        {
            AutoSize = true,
            FlowDirection = FlowDirection.TopDown,
            WrapContents = false,
            BackColor = Color.Transparent,
            Anchor = AnchorStyles.None
        };
        loadingStack.Controls.Add(statusLabel);
        loadingStack.Controls.Add(retryButton);

        var loadingLayout = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            BackColor = Color.FromArgb(20, 20, 22),
            ColumnCount = 1,
            RowCount = 1
        };
        loadingLayout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        loadingLayout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        loadingLayout.Controls.Add(loadingStack, 0, 0);

        loadingPanel = new Panel
        {
            Dock = DockStyle.Fill,
            BackColor = Color.FromArgb(20, 20, 22)
        };
        loadingPanel.Controls.Add(loadingLayout);

        Controls.Add(webView);
        Controls.Add(embeddedBrowser);
        Controls.Add(loadingPanel);
        loadingPanel.BringToFront();

        Shown += async (_, _) => await StartAsync();
        FormClosed += (_, _) => httpClient.Dispose();
        Resize += async (_, _) =>
        {
            UpdateMaximizedBounds();
            await PublishDesktopBridgeAsync();
        };
    }

    public void RestoreAndActivate()
    {
        if (WindowState == FormWindowState.Minimized)
        {
            WindowState = FormWindowState.Normal;
        }

        Show();
        Activate();
        BringToFront();
    }

    private async Task StartAsync()
    {
        if (startupRunning)
        {
            return;
        }

        startupRunning = true;
        retryButton.Visible = false;
        statusLabel.Text = "正在启动 DeepSeek Harness…";
        loadingPanel.Visible = true;
        loadingPanel.BringToFront();

        try
        {
            if (!await IsHarnessReadyAsync())
            {
                if (IsExternalBackendOnly())
                {
                    throw new InvalidOperationException($"指定的 DSH 后端尚未就绪：{HarnessUri}");
                }

                await StartBackendAsync();
            }

            await WaitUntilReadyAsync();
            await InitializeWebViewAsync();
            webView.CoreWebView2.Navigate(HarnessUri.AbsoluteUri);
            _ = HideLoadingWhenDocumentReadyAsync(webView.CoreWebView2);
        }
        catch (Exception exception)
        {
            statusLabel.Text = $"启动失败：{exception.Message}";
            retryButton.Visible = true;
        }
        finally
        {
            startupRunning = false;
        }
    }

    private async Task StartBackendAsync()
    {
        var appRoot = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "DeepSeekHarness");
        var launcherPath = Path.Combine(appRoot, "launcher", "Start-DeepSeekHarness.ps1");
        if (!File.Exists(launcherPath))
        {
            throw new FileNotFoundException("找不到 DSH 后台启动脚本", launcherPath);
        }

        var startInfo = new ProcessStartInfo
        {
            FileName = "powershell.exe",
            UseShellExecute = false,
            CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden
        };
        startInfo.ArgumentList.Add("-NoProfile");
        startInfo.ArgumentList.Add("-ExecutionPolicy");
        startInfo.ArgumentList.Add("Bypass");
        startInfo.ArgumentList.Add("-File");
        startInfo.ArgumentList.Add(launcherPath);
        startInfo.ArgumentList.Add("-NoBrowser");
        startInfo.ArgumentList.Add("-Silent");

        using var process = Process.Start(startInfo) ?? throw new InvalidOperationException("无法启动 DSH 后台进程");
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(190));
        await process.WaitForExitAsync(timeout.Token);
        if (process.ExitCode != 0)
        {
            throw new InvalidOperationException("DSH 后台启动器返回错误，请查看 logs\\launcher-errors.log");
        }
    }

    private async Task WaitUntilReadyAsync()
    {
        for (var attempt = 0; attempt < 60; attempt++)
        {
            if (await IsHarnessReadyAsync())
            {
                return;
            }

            await Task.Delay(500);
        }

        throw new TimeoutException("DSH 后台服务在 30 秒内没有就绪");
    }

    private async Task<bool> IsHarnessReadyAsync()
    {
        try
        {
            using var response = await httpClient.GetAsync(HarnessUri);
            return response.IsSuccessStatusCode;
        }
        catch (HttpRequestException)
        {
            return false;
        }
        catch (TaskCanceledException)
        {
            return false;
        }
    }

    private async Task InitializeWebViewAsync()
    {
        if (webView.CoreWebView2 is not null && embeddedBrowser.CoreWebView2 is not null)
        {
            return;
        }

        var appRoot = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "DeepSeekHarness");
        var userDataFolder = Environment.GetEnvironmentVariable("DSH_DESKTOP_USER_DATA_FOLDER");
        if (string.IsNullOrWhiteSpace(userDataFolder))
        {
            userDataFolder = Path.Combine(appRoot, "state", "webview2");
        }

        Directory.CreateDirectory(userDataFolder);

        CoreWebView2EnvironmentOptions? options = null;
        var debugPortText = Environment.GetEnvironmentVariable("DSH_DESKTOP_WEBVIEW2_DEBUG_PORT");
        if (!string.IsNullOrWhiteSpace(debugPortText))
        {
            if (!int.TryParse(debugPortText, out var debugPort) || debugPort < 1024 || debugPort > 65535)
            {
                throw new InvalidOperationException("DSH_DESKTOP_WEBVIEW2_DEBUG_PORT 必须是 1024 到 65535 之间的端口");
            }

            options = new CoreWebView2EnvironmentOptions($"--remote-debugging-port={debugPort}");
        }

        webViewEnvironment ??= await CoreWebView2Environment.CreateAsync(
            userDataFolder: userDataFolder,
            options: options);
        await webView.EnsureCoreWebView2Async(webViewEnvironment);

        var core = webView.CoreWebView2
            ?? throw new InvalidOperationException("WebView2 初始化未完成");
        await core.AddScriptToExecuteOnDocumentCreatedAsync(BuildDesktopBridgeScript());
        core.WebMessageReceived += OnMainWebMessageReceived;
        core.Settings.AreDefaultContextMenusEnabled = false;
        core.Settings.AreDevToolsEnabled = false;
        core.Settings.IsStatusBarEnabled = false;
        core.Settings.IsZoomControlEnabled = true;
        core.DocumentTitleChanged += (_, _) => Text = "DeepSeek Harness";
        core.DOMContentLoaded += (_, _) => BeginInvoke(ShowContent);
        core.NavigationCompleted += (_, args) =>
        {
            if (args.IsSuccess)
            {
                ShowContent();
                return;
            }

            statusLabel.Text = $"页面加载失败：{args.WebErrorStatus}";
            retryButton.Visible = true;
            loadingPanel.Visible = true;
            loadingPanel.BringToFront();
        };
        core.NewWindowRequested += (_, args) =>
        {
            args.Handled = true;
            Process.Start(new ProcessStartInfo(args.Uri) { UseShellExecute = true });
        };

        await embeddedBrowser.EnsureCoreWebView2Async(webViewEnvironment);
        var embeddedCore = embeddedBrowser.CoreWebView2
            ?? throw new InvalidOperationException("内置浏览器 WebView2 初始化未完成");
        await embeddedCore.AddScriptToExecuteOnDocumentCreatedAsync(EmbeddedBrowserObserverScript);
        embeddedCore.WebMessageReceived += OnEmbeddedBrowserWebMessageReceived;
        embeddedCore.Settings.AreDefaultContextMenusEnabled = true;
        embeddedCore.Settings.AreDevToolsEnabled = false;
        embeddedCore.Settings.IsStatusBarEnabled = false;
        embeddedCore.Settings.IsZoomControlEnabled = true;
        embeddedCore.NavigationStarting += async (_, _) =>
        {
            await DispatchMainWindowEventAsync(
                "dsh:browser:console-errors",
                JsonSerializer.Serialize(new { type = "dsh.embeddedBrowser.console-errors", reset = true, entries = Array.Empty<object>() }));
            await PublishEmbeddedBrowserStateAsync("loading");
        };
        embeddedCore.NavigationCompleted += async (_, args) => await PublishEmbeddedBrowserStateAsync(args.IsSuccess ? "complete" : "failed");
        embeddedCore.SourceChanged += async (_, _) => await PublishEmbeddedBrowserStateAsync("source-changed");
        embeddedCore.DocumentTitleChanged += async (_, _) => await PublishEmbeddedBrowserStateAsync("title-changed");
        embeddedCore.NewWindowRequested += (_, args) =>
        {
            args.Handled = true;
            if (TryNormalizeBrowserUri(args.Uri, out var uri, out var ignoredError))
            {
                embeddedCore.Navigate(uri.AbsoluteUri);
            }
        };
        embeddedCore.Navigate("about:blank");
    }

    private async Task HideLoadingWhenDocumentReadyAsync(CoreWebView2? core)
    {
        if (core is null)
        {
            return;
        }

        for (var attempt = 0; attempt < 40; attempt++)
        {
            try
            {
                var state = await core.ExecuteScriptAsync("document.readyState");
                if (state.Contains("interactive", StringComparison.OrdinalIgnoreCase)
                    || state.Contains("complete", StringComparison.OrdinalIgnoreCase))
                {
                    BeginInvoke(ShowContent);
                    return;
                }
            }
            catch (InvalidOperationException)
            {
            }
            catch (COMException)
            {
            }

            await Task.Delay(250);
        }
    }

    private void ShowContent()
    {
        if (IsDisposed)
        {
            return;
        }

        loadingPanel.Visible = false;
        loadingPanel.SendToBack();
        webView.BringToFront();
        if (embeddedBrowser.Visible)
        {
            embeddedBrowser.BringToFront();
        }

        webView.Focus();
    }

    private async void OnMainWebMessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs args)
    {
        try
        {
            if (!IsTrustedMainMessage(args.Source))
            {
                return;
            }

            using var document = JsonDocument.Parse(args.WebMessageAsJson);
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object || !TryGetString(root, "type", out var type))
            {
                return;
            }

            switch (type)
            {
                case "dsh.desktop.command":
                    if (TryGetString(root, "command", out var command))
                    {
                        HandleDesktopCommand(command);
                    }
                    break;
                case "dsh.embeddedBrowser.setBounds":
                    HandleEmbeddedBrowserBounds(root);
                    break;
                case "dsh.embeddedBrowser.navigate":
                    HandleEmbeddedBrowserNavigate(root);
                    break;
                case "dsh.embeddedBrowser.history":
                    HandleEmbeddedBrowserHistory(root);
                    break;
                case "dsh.embeddedBrowser.pickElement":
                    await HandleEmbeddedBrowserPickAsync();
                    break;
                case "dsh.workspaceFiles.request":
                    await HandleWorkspaceFilesRequestAsync(root.Clone());
                    break;
                case "dsh.terminal.run":
                    await HandleTerminalRunAsync(root.Clone());
                    break;
            }
        }
        catch (JsonException)
        {
        }
        catch (InvalidOperationException)
        {
        }
    }

    private async void OnEmbeddedBrowserWebMessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs args)
    {
        try
        {
            using var document = JsonDocument.Parse(args.WebMessageAsJson);
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object || !TryGetString(root, "type", out var type))
            {
                return;
            }

            if (!string.Equals(type, "dsh.embeddedBrowser.console-errors", StringComparison.Ordinal)
                && !string.Equals(type, "dsh.embeddedBrowser.element-picked", StringComparison.Ordinal))
            {
                return;
            }

            var detail = root.Clone();
            var eventName = string.Equals(type, "dsh.embeddedBrowser.element-picked", StringComparison.Ordinal)
                ? "dsh:browser:element-picked"
                : "dsh:browser:console-errors";
            await DispatchMainWindowEventAsync(eventName, detail.GetRawText());
        }
        catch (JsonException)
        {
        }
        catch (InvalidOperationException)
        {
        }
    }

    private void HandleDesktopCommand(string command)
    {
        switch (command)
        {
            case "minimize":
                WindowState = FormWindowState.Minimized;
                break;
            case "maximize":
                UpdateMaximizedBounds();
                WindowState = FormWindowState.Maximized;
                _ = PublishDesktopBridgeAsync();
                break;
            case "restore":
                WindowState = FormWindowState.Normal;
                _ = PublishDesktopBridgeAsync();
                break;
            case "close":
                Close();
                break;
            case "startDrag":
                StartWindowDrag();
                break;
        }
    }

    private void StartWindowDrag()
    {
        if (!customTitlebarEnabled || WindowState == FormWindowState.Minimized)
        {
            return;
        }

        ReleaseCapture();
        SendMessage(Handle, WmNcLeftButtonDown, HtCaption, IntPtr.Zero);
    }

    private void HandleEmbeddedBrowserBounds(JsonElement root)
    {
        if (!TryGetBoolean(root, "visible", out var visible)
            || !visible
            || !root.TryGetProperty("rect", out var rect)
            || rect.ValueKind != JsonValueKind.Object)
        {
            embeddedBrowser.Visible = false;
            return;
        }

        var requested = new Rectangle(
            GetInt32(rect, "left"),
            GetInt32(rect, "top"),
            Math.Max(0, GetInt32(rect, "width")),
            Math.Max(0, GetInt32(rect, "height")));
        var clipped = Rectangle.Intersect(ClientRectangle, requested);
        if (clipped.Width <= 0 || clipped.Height <= 0)
        {
            embeddedBrowser.Visible = false;
            return;
        }

        embeddedBrowser.Bounds = clipped;
        embeddedBrowser.Visible = true;
        embeddedBrowser.BringToFront();
        if (loadingPanel.Visible)
        {
            loadingPanel.BringToFront();
        }
    }

    private void HandleEmbeddedBrowserNavigate(JsonElement root)
    {
        var core = embeddedBrowser.CoreWebView2;
        if (core is null || !TryGetString(root, "url", out var rawUrl))
        {
            return;
        }

        if (!TryNormalizeBrowserUri(rawUrl, out var uri, out var ignoredError))
        {
            return;
        }

        core.Navigate(uri.AbsoluteUri);
    }

    private void HandleEmbeddedBrowserHistory(JsonElement root)
    {
        var core = embeddedBrowser.CoreWebView2;
        if (core is null || !TryGetString(root, "command", out var command))
        {
            return;
        }

        switch (command)
        {
            case "back":
                if (core.CanGoBack)
                {
                    core.GoBack();
                }
                break;
            case "forward":
                if (core.CanGoForward)
                {
                    core.GoForward();
                }
                break;
            case "reload":
                core.Reload();
                break;
        }
    }

    private async Task HandleEmbeddedBrowserPickAsync()
    {
        var core = embeddedBrowser.CoreWebView2;
        if (core is null)
        {
            return;
        }

        await core.ExecuteScriptAsync(EmbeddedBrowserPickScript);
    }

    private async Task HandleWorkspaceFilesRequestAsync(JsonElement root)
    {
        if (!TryGetString(root, "id", out var id) || !TryGetString(root, "op", out var op))
        {
            return;
        }

        try
        {
            var result = await Task.Run<object>(() =>
            {
                return op switch
                {
                    "listDirectory" => ListWorkspaceDirectory(GetOptionalString(root, "path")),
                    "readFile" => ReadWorkspaceFile(GetOptionalString(root, "path"), GetOptionalObject(root, "request")),
                    "writeFile" => WriteWorkspaceFile(GetOptionalString(root, "path"), GetOptionalString(root, "text"), GetOptionalObject(root, "options")),
                    "search" => SearchWorkspaceFiles(GetOptionalString(root, "query")),
                    _ => throw new InvalidOperationException("不支持的文件操作：" + op)
                };
            });
            await PostMainWebMessageAsync(new { type = "dsh.workspaceFiles.response", id, ok = true, result });
        }
        catch (Exception exception)
        {
            await PostMainWebMessageAsync(new
            {
                type = "dsh.workspaceFiles.response",
                id,
                ok = false,
                error = exception.Message
            });
        }
    }

    private async Task HandleTerminalRunAsync(JsonElement root)
    {
        if (!TryGetString(root, "id", out var id))
        {
            return;
        }

        var command = GetOptionalString(root, "command");
        try
        {
            var result = await RunTerminalCommandAsync(command);
            await PostMainWebMessageAsync(new { type = "dsh.terminal.response", id, ok = true, result });
        }
        catch (Exception exception)
        {
            await PostMainWebMessageAsync(new
            {
                type = "dsh.terminal.response",
                id,
                ok = false,
                error = exception.Message
            });
        }
    }

    private object ListWorkspaceDirectory(string requestPath)
    {
        var directory = ResolveWorkspacePath(requestPath, requireExisting: true);
        if (!Directory.Exists(directory))
        {
            throw new DirectoryNotFoundException("不是目录：" + directory);
        }

        var entries = new List<object>();
        foreach (var item in Directory.EnumerateFileSystemEntries(directory)
                     .OrderBy(path => Directory.Exists(path) ? 0 : 1)
                     .ThenBy(Path.GetFileName, StringComparer.OrdinalIgnoreCase)
                     .Take(DirectoryEntryLimit + 1))
        {
            if (entries.Count >= DirectoryEntryLimit)
            {
                break;
            }

            var attributes = File.GetAttributes(item);
            var isDirectory = attributes.HasFlag(FileAttributes.Directory);
            var info = isDirectory ? null : new FileInfo(item);
            entries.Add(new
            {
                path = item,
                name = Path.GetFileName(item),
                kind = isDirectory ? "directory" : "file",
                size = isDirectory ? (long?)null : info?.Length,
                binary = !isDirectory && IsLikelyBinaryPath(item),
                ignored = isDirectory && IgnoredDirectoryNames.Contains(Path.GetFileName(item), StringComparer.OrdinalIgnoreCase),
                symlink = attributes.HasFlag(FileAttributes.ReparsePoint)
            });
        }

        return new
        {
            path = directory,
            rootPath = workspaceRoot,
            entries,
            nextCursor = (string?)null,
            truncated = entries.Count >= DirectoryEntryLimit
        };
    }

    private object ReadWorkspaceFile(string requestPath, JsonElement request)
    {
        var filePath = ResolveWorkspacePath(requestPath, requireExisting: true);
        if (!File.Exists(filePath))
        {
            throw new FileNotFoundException("不是文件：" + filePath, filePath);
        }

        var info = new FileInfo(filePath);
        var revision = FileRevision(info);
        var startLine = Math.Max(1, GetInt32(request, "startLine"));
        if (startLine <= 0)
        {
            startLine = 1;
        }

        var maxLines = GetInt32(request, "maxLines");
        if (maxLines <= 0 || maxLines > FileReadMaxLines)
        {
            maxLines = FileReadMaxLines;
        }

        var maxBytes = GetInt32(request, "maxBytes");
        if (maxBytes <= 0 || maxBytes > FileReadMaxBytes)
        {
            maxBytes = FileReadMaxBytes;
        }

        if (IsLikelyBinaryPath(filePath) || ContainsBinaryPrefix(filePath))
        {
            return new
            {
                path = filePath,
                lines = Array.Empty<object>(),
                startLine,
                endLine = startLine - 1,
                nextStartLine = (int?)null,
                totalLines = 0,
                totalLinesKnown = true,
                truncated = false,
                binary = true,
                byteLength = info.Length,
                encoding = "binary",
                revision,
                lang = GuessLanguage(filePath)
            };
        }

        var lines = new List<object>();
        var lineNumber = 0;
        var capturedBytes = 0;
        int? nextStartLine = null;
        var truncated = false;
        var totalLinesKnown = true;
        using var reader = new StreamReader(filePath, Encoding.UTF8, detectEncodingFromByteOrderMarks: true);
        while (reader.ReadLine() is { } line)
        {
            lineNumber += 1;
            if (lineNumber < startLine)
            {
                continue;
            }

            var lineBytes = Encoding.UTF8.GetByteCount(line) + 1;
            var canCapture = lines.Count < maxLines && capturedBytes + lineBytes <= maxBytes;
            if (canCapture)
            {
                var text = line.Length > 8000 ? line[..8000] + "…" : line;
                lines.Add(new { number = lineNumber, text });
                capturedBytes += lineBytes;
                truncated = truncated || text.Length != line.Length;
                continue;
            }

            nextStartLine ??= lineNumber;
            truncated = true;
            if (lineNumber - startLine > 100000)
            {
                totalLinesKnown = false;
                break;
            }
        }

        var endLine = lines.Count == 0 ? startLine - 1 : startLine + lines.Count - 1;
        return new
        {
            path = filePath,
            lines,
            startLine,
            endLine,
            nextStartLine,
            totalLines = lineNumber,
            totalLinesKnown,
            truncated,
            binary = false,
            byteLength = info.Length,
            encoding = "utf-8",
            revision,
            lang = GuessLanguage(filePath)
        };
    }

    private object WriteWorkspaceFile(string requestPath, string text, JsonElement options)
    {
        var filePath = ResolveWorkspacePath(requestPath, requireExisting: true);
        if (!File.Exists(filePath))
        {
            throw new FileNotFoundException("不是文件：" + filePath, filePath);
        }

        if (IsLikelyBinaryPath(filePath) || ContainsBinaryPrefix(filePath))
        {
            throw new InvalidOperationException("二进制文件不可编辑：" + filePath);
        }

        if (text.Length > FileWriteMaxChars)
        {
            throw new InvalidOperationException("保存内容超过 1MiB 安全上限");
        }

        var info = new FileInfo(filePath);
        var currentRevision = FileRevision(info);
        var expectedRevision = GetOptionalString(options, "revision");
        if (!string.IsNullOrWhiteSpace(expectedRevision) && !string.Equals(expectedRevision, currentRevision, StringComparison.Ordinal))
        {
            throw new InvalidOperationException("文件已经在磁盘上变化，请刷新后再保存");
        }

        CreateWorkspaceFileBackup(filePath);
        File.WriteAllText(filePath, text, new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
        var nextInfo = new FileInfo(filePath);
        return new
        {
            path = filePath,
            revision = FileRevision(nextInfo),
            byteLength = nextInfo.Length,
            savedAt = DateTimeOffset.UtcNow.ToString("O")
        };
    }

    private object SearchWorkspaceFiles(string query)
    {
        var trimmed = query.Trim();
        if (trimmed.Length == 0)
        {
            return new { entries = Array.Empty<object>(), truncated = false };
        }

        var entries = new List<object>();
        var visited = 0;
        foreach (var file in EnumerateWorkspaceFiles(workspaceRoot))
        {
            visited += 1;
            if (visited > 5000)
            {
                break;
            }

            var name = Path.GetFileName(file);
            if (!name.Contains(trimmed, StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            var info = new FileInfo(file);
            entries.Add(new
            {
                path = file,
                name,
                kind = "file",
                size = info.Length,
                binary = IsLikelyBinaryPath(file),
                ignored = false,
                symlink = info.Attributes.HasFlag(FileAttributes.ReparsePoint)
            });
            if (entries.Count >= 200)
            {
                break;
            }
        }

        return new { entries, truncated = entries.Count >= 200 || visited > 5000 };
    }

    private async Task<object> RunTerminalCommandAsync(string command)
    {
        var trimmed = command.Trim();
        if (trimmed.Length == 0)
        {
            throw new InvalidOperationException("终端命令不能为空");
        }

        if (trimmed.Length > TerminalCommandMaxChars)
        {
            throw new InvalidOperationException("终端命令过长");
        }

        var utf8Preamble = "$ProgressPreference='SilentlyContinue'; [Console]::InputEncoding=[System.Text.UTF8Encoding]::new($false); [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); $OutputEncoding=[Console]::OutputEncoding;";
        var encodedCommand = Convert.ToBase64String(Encoding.Unicode.GetBytes(utf8Preamble + Environment.NewLine + trimmed));
        var startInfo = new ProcessStartInfo
        {
            FileName = "powershell.exe",
            WorkingDirectory = workspaceRoot,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8
        };
        startInfo.ArgumentList.Add("-NoLogo");
        startInfo.ArgumentList.Add("-NoProfile");
        startInfo.ArgumentList.Add("-ExecutionPolicy");
        startInfo.ArgumentList.Add("Bypass");
        startInfo.ArgumentList.Add("-EncodedCommand");
        startInfo.ArgumentList.Add(encodedCommand);

        var stdout = new StringBuilder();
        var stderr = new StringBuilder();
        var outputClosed = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var errorClosed = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var stopwatch = Stopwatch.StartNew();
        using var process = new Process { StartInfo = startInfo, EnableRaisingEvents = true };
        process.OutputDataReceived += (_, args) =>
        {
            if (args.Data is null)
            {
                outputClosed.TrySetResult();
                return;
            }

            AppendLimited(stdout, args.Data + Environment.NewLine);
        };
        process.ErrorDataReceived += (_, args) =>
        {
            if (args.Data is null)
            {
                errorClosed.TrySetResult();
                return;
            }

            AppendLimited(stderr, args.Data + Environment.NewLine);
        };

        process.Start();
        process.BeginOutputReadLine();
        process.BeginErrorReadLine();

        var timedOut = false;
        using var timeout = new CancellationTokenSource(TerminalTimeoutMs);
        try
        {
            await process.WaitForExitAsync(timeout.Token);
        }
        catch (OperationCanceledException)
        {
            timedOut = true;
            try
            {
                process.Kill(entireProcessTree: true);
            }
            catch (InvalidOperationException)
            {
            }

            await process.WaitForExitAsync();
        }

        await Task.WhenAll(outputClosed.Task, errorClosed.Task);
        stopwatch.Stop();
        var stdoutText = StripPowerShellCliXml(stdout.ToString());
        var stderrText = StripPowerShellCliXml(stderr.ToString());
        return new
        {
            command = trimmed,
            cwd = workspaceRoot,
            exitCode = timedOut ? -1 : process.ExitCode,
            stdout = stdoutText,
            stderr = stderrText,
            stdoutTruncated = stdoutText.Length >= TerminalOutputLimit || stdout.Length >= TerminalOutputLimit,
            stderrTruncated = stderrText.Length >= TerminalOutputLimit || stderr.Length >= TerminalOutputLimit,
            timedOut,
            durationMs = stopwatch.ElapsedMilliseconds
        };
    }

    private static string StripPowerShellCliXml(string value)
    {
        if (string.IsNullOrEmpty(value) || !value.Contains("#< CLIXML", StringComparison.OrdinalIgnoreCase))
        {
            return StripPowerShellBootstrap(value);
        }

        var normalized = value.Replace("\r\n", "\n").Replace('\r', '\n');
        var extracted = ExtractPowerShellCliXmlStringNodes(normalized);
        if (!string.IsNullOrWhiteSpace(extracted))
        {
            return StripPowerShellBootstrap(extracted);
        }

        var lines = normalized.Split('\n');
        var builder = new StringBuilder();
        var skippingCliXml = false;
        for (var index = 0; index < lines.Length; index += 1)
        {
            var line = lines[index];
            var trimmed = line.TrimStart('\uFEFF', ' ', '\t');
            if (trimmed.StartsWith("#< CLIXML", StringComparison.OrdinalIgnoreCase))
            {
                skippingCliXml = true;
                continue;
            }

            if (skippingCliXml && IsPowerShellCliXmlLine(trimmed))
            {
                AppendPowerShellCliXmlStringNodes(builder, trimmed);
                continue;
            }

            skippingCliXml = false;
            builder.Append(line);
            if (index < lines.Length - 1)
            {
                builder.AppendLine();
            }
        }

        return StripPowerShellBootstrap(builder.ToString());
    }

    private static string ExtractPowerShellCliXmlStringNodes(string value)
    {
        var builder = new StringBuilder();
        AppendPowerShellCliXmlStringNodes(builder, value);
        return builder.ToString();
    }

    private static void AppendPowerShellCliXmlStringNodes(StringBuilder builder, string line)
    {
        foreach (Match match in Regex.Matches(line, "<S\\b[^>]*>(.*?)</S>", RegexOptions.Singleline))
        {
            var decoded = DecodePowerShellCliXmlText(match.Groups[1].Value);
            if (decoded.Length == 0)
            {
                continue;
            }

            builder.Append(decoded);
            if (!decoded.EndsWith('\n'))
            {
                builder.AppendLine();
            }
        }
    }

    private static string DecodePowerShellCliXmlText(string value)
    {
        var decoded = WebUtility.HtmlDecode(value);
        decoded = Regex.Replace(decoded, "_x([0-9A-Fa-f]{4})_", match =>
        {
            var codePoint = Convert.ToInt32(match.Groups[1].Value, 16);
            return char.ConvertFromUtf32(codePoint);
        });
        return StripPowerShellBootstrap(decoded);
    }

    private static string StripPowerShellBootstrap(string value)
    {
        if (string.IsNullOrEmpty(value))
        {
            return value;
        }

        const string outputEncodingReference = @"O\s*u\s*t\s*p\s*u\s*t\s*E\s*n\s*c\s*o\s*d\s*i\s*n\s*g";
        var pattern = @"\$ProgressPreference='SilentlyContinue';[\s\S]*?\$OutputEncoding\s*=\s*\[Console\]\s*::\s*" + outputEncodingReference + @"\s*;";
        return Regex.Replace(value, pattern, string.Empty, RegexOptions.CultureInvariant).TrimStart();
    }

    private static bool IsPowerShellCliXmlLine(string trimmed)
    {
        if (trimmed.Length == 0)
        {
            return true;
        }

        return trimmed.StartsWith("<Objs", StringComparison.Ordinal)
            || trimmed.StartsWith("</Objs", StringComparison.Ordinal)
            || trimmed.StartsWith("<Obj", StringComparison.Ordinal)
            || trimmed.StartsWith("</Obj", StringComparison.Ordinal)
            || trimmed.StartsWith("<TN", StringComparison.Ordinal)
            || trimmed.StartsWith("</TN", StringComparison.Ordinal)
            || trimmed.StartsWith("<T>", StringComparison.Ordinal)
            || trimmed.StartsWith("</T>", StringComparison.Ordinal)
            || trimmed.StartsWith("<MS", StringComparison.Ordinal)
            || trimmed.StartsWith("</MS", StringComparison.Ordinal)
            || trimmed.StartsWith("<S ", StringComparison.Ordinal)
            || trimmed.StartsWith("<I32", StringComparison.Ordinal)
            || trimmed.StartsWith("<B", StringComparison.Ordinal)
            || trimmed.StartsWith("<Nil", StringComparison.Ordinal)
            || trimmed.StartsWith("<Ref", StringComparison.Ordinal)
            || trimmed.StartsWith("<Props", StringComparison.Ordinal)
            || trimmed.StartsWith("</Props", StringComparison.Ordinal)
            || trimmed.StartsWith("<ToString", StringComparison.Ordinal)
            || trimmed.StartsWith("<LST", StringComparison.Ordinal);
    }

    private async Task PostMainWebMessageAsync(object payload)
    {
        var core = webView.CoreWebView2;
        if (core is null)
        {
            return;
        }

        core.PostWebMessageAsJson(JsonSerializer.Serialize(payload));
        await Task.CompletedTask;
    }

    private async Task PublishDesktopBridgeAsync()
    {
        var core = webView.CoreWebView2;
        if (core is null)
        {
            return;
        }

        try
        {
            await core.ExecuteScriptAsync(BuildDesktopBridgeScript());
        }
        catch (InvalidOperationException)
        {
        }
    }

    private async Task DispatchMainWindowEventAsync(string eventName, string detailJson)
    {
        var core = webView.CoreWebView2;
        if (core is null)
        {
            return;
        }

        var eventNameJson = JsonSerializer.Serialize(eventName);
        await core.ExecuteScriptAsync(
            $"window.dispatchEvent(new CustomEvent({eventNameJson}, {{ detail: {detailJson} }}));");
    }

    private async Task PublishEmbeddedBrowserStateAsync(string phase)
    {
        var core = embeddedBrowser.CoreWebView2;
        if (core is null)
        {
            return;
        }

        var detail = JsonSerializer.Serialize(new
        {
            type = "dsh.embeddedBrowser.state",
            phase,
            url = core.Source ?? "",
            title = core.DocumentTitle ?? "",
            canGoBack = core.CanGoBack,
            canGoForward = core.CanGoForward
        });
        await DispatchMainWindowEventAsync("dsh:browser:state", detail);
    }

    private string BuildDesktopBridgeScript()
    {
        var bridgeJson = JsonSerializer.Serialize(new
        {
            platform = "win32",
            titlebarMode = customTitlebarEnabled ? "custom" : "native-panel",
            titlebarHeight = DesktopTitlebarHeight,
            workspaceRoot,
            windowState = WindowState == FormWindowState.Maximized ? "maximized" : WindowState == FormWindowState.Minimized ? "minimized" : "normal",
            isMaximized = WindowState == FormWindowState.Maximized,
            capabilities = new
            {
                customTitlebar = customTitlebarEnabled,
                rightWorkspace = true,
                embeddedBrowser = true,
                files = true,
                terminal = true
            }
        });
        return $$"""
            (() => {
                const bridge = {{bridgeJson}};
                const ensureBridge = () => {
                    try {
                        Object.defineProperty(window, "__dshDesktop", {
                            value: bridge,
                            writable: true,
                            configurable: true
                        });
                    } catch {
                        window.__dshDesktop = bridge;
                    }
                };
                ensureBridge();
                if (window.__dshDesktopBridgeInstalled !== true) {
                    window.__dshDesktopBridgeInstalled = true;
                    let nextId = 1;
                    const pending = new Map();
                    const request = (op, payload) => new Promise((resolve, reject) => {
                        const id = "dsh-file-" + Date.now().toString(36) + "-" + (nextId++).toString(36);
                        pending.set(id, { resolve, reject });
                        try {
                            window.chrome?.webview?.postMessage?.(Object.assign({
                                type: "dsh.workspaceFiles.request",
                                id,
                                op
                            }, payload || {}));
                        } catch (error) {
                            pending.delete(id);
                            reject(error);
                            return;
                        }
                        window.setTimeout(() => {
                            const slot = pending.get(id);
                            if (slot === undefined) return;
                            pending.delete(id);
                            slot.reject(new Error("文件操作超时"));
                        }, 30000);
                    });
                    window.chrome?.webview?.addEventListener?.("message", (event) => {
                        const data = event.data;
                        if (data === null || typeof data !== "object" || data.type !== "dsh.workspaceFiles.response") return;
                        const slot = pending.get(data.id);
                        if (slot === undefined) return;
                        pending.delete(data.id);
                        if (data.ok === true) slot.resolve(data.result);
                        else slot.reject(new Error(String(data.error || "文件操作失败")));
                    });
                    window.__dshWorkspaceFiles = {
                        rootPath: bridge.workspaceRoot,
                        listDirectory: (path, options) => request("listDirectory", { path: String(path || ""), options: options || {} }),
                        readFile: (path, fileRequest) => request("readFile", { path: String(path || ""), request: fileRequest || {} }),
                        writeFile: (path, text, options) => request("writeFile", { path: String(path || ""), text: String(text ?? ""), options: options || {} }),
                        search: (query, options) => request("search", { query: String(query || ""), options: options || {} })
                    };
                } else if (window.__dshWorkspaceFiles && typeof window.__dshWorkspaceFiles === "object") {
                    window.__dshWorkspaceFiles.rootPath = bridge.workspaceRoot;
                }
                try {
                    window.__dshDesktop = bridge;
                } catch {
                    ensureBridge();
                }
                window.dispatchEvent(new CustomEvent("dsh:desktop:ready", { detail: bridge }));
            })();
            """;
    }

    private static readonly string EmbeddedBrowserObserverScript = $$"""
        (() => {
            if (window.__dshEmbeddedBrowserObserverInstalled === true) return;
            window.__dshEmbeddedBrowserObserverInstalled = true;
            const serializeValue = (value) => {
                try {
                    if (value instanceof Error) return value.stack || value.message || String(value);
                    if (typeof value === "string") return value;
                    return JSON.stringify(value);
                } catch {
                    return String(value);
                }
            };
            const postEntries = (entries) => {
                try {
                    window.chrome?.webview?.postMessage?.({
                        type: "dsh.embeddedBrowser.console-errors",
                        source: "embedded-browser",
                        url: String(location.href || ""),
                        reset: false,
                        entries
                    });
                } catch {
                }
            };
            const makeEntry = (message, extra) => Object.assign({
                message: String(message || "").slice(0, 2000),
                source: "console.error",
                time: new Date().toISOString()
            }, extra || {});
            const originalError = console.error;
            console.error = function(...args) {
                postEntries([makeEntry(args.map(serializeValue).join(" "))]);
                return originalError.apply(this, args);
            };
            window.addEventListener("error", (event) => {
                postEntries([makeEntry(event.message, {
                    source: event.filename || "window.error",
                    line: Number.isFinite(event.lineno) ? event.lineno : undefined,
                    column: Number.isFinite(event.colno) ? event.colno : undefined,
                    stack: event.error?.stack
                })]);
            });
            window.addEventListener("unhandledrejection", (event) => {
                postEntries([makeEntry(serializeValue(event.reason), {
                    source: "unhandledrejection",
                    stack: event.reason?.stack
                })]);
            });
        })();
        """;

    private static readonly string EmbeddedBrowserPickScript = """
        (() => {
            if (window.__dshElementPickActive === true) return "already-active";
            window.__dshElementPickActive = true;
            const cssEscape = window.CSS && typeof window.CSS.escape === "function"
                ? window.CSS.escape.bind(window.CSS)
                : (value) => String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
            const selectorFor = (element) => {
                if (!(element instanceof Element)) return "";
                if (element.id) return "#" + cssEscape(element.id);
                const parts = [];
                let node = element;
                while (node instanceof Element && parts.length < 5) {
                    let part = node.localName || node.tagName.toLowerCase();
                    const className = typeof node.className === "string" ? node.className.trim().split(/\s+/).filter(Boolean)[0] : "";
                    if (className) part += "." + cssEscape(className);
                    const parent = node.parentElement;
                    if (parent) {
                        const siblings = Array.from(parent.children).filter((child) => child.localName === node.localName);
                        if (siblings.length > 1) part += ":nth-of-type(" + (siblings.indexOf(node) + 1) + ")";
                    }
                    parts.unshift(part);
                    node = parent;
                }
                return parts.join(" > ");
            };
            const xpathFor = (element) => {
                const parts = [];
                let node = element;
                while (node instanceof Element && node.nodeType === 1 && parts.length < 8) {
                    let index = 1;
                    let sibling = node.previousElementSibling;
                    while (sibling) {
                        if (sibling.localName === node.localName) index += 1;
                        sibling = sibling.previousElementSibling;
                    }
                    parts.unshift(node.localName + "[" + index + "]");
                    node = node.parentElement;
                }
                return "/" + parts.join("/");
            };
            const onClick = (event) => {
                event.preventDefault();
                event.stopPropagation();
                window.__dshElementPickActive = false;
                document.removeEventListener("click", onClick, true);
                const element = event.target instanceof Element ? event.target : null;
                if (element === null) return;
                const rect = element.getBoundingClientRect();
                const payload = {
                    type: "dsh.embeddedBrowser.element-picked",
                    url: String(location.href || ""),
                    title: String(document.title || ""),
                    tagName: String(element.tagName || "").toLowerCase(),
                    textPreview: String(element.innerText || element.textContent || "").replace(/\s+/g, " ").trim().slice(0, 2000),
                    selector: selectorFor(element),
                    xpath: xpathFor(element),
                    outerHtmlPreview: String(element.outerHTML || "").slice(0, 4000),
                    rect: {
                        x: Math.round(rect.x),
                        y: Math.round(rect.y),
                        width: Math.round(rect.width),
                        height: Math.round(rect.height)
                    },
                    attributes: {
                        id: element.getAttribute("id") || "",
                        class: element.getAttribute("class") || "",
                        role: element.getAttribute("role") || "",
                        ariaLabel: element.getAttribute("aria-label") || ""
                    },
                    pickedAt: new Date().toISOString()
                };
                try {
                    window.chrome?.webview?.postMessage?.(payload);
                } catch {
                }
            };
            document.addEventListener("click", onClick, true);
            return "armed";
        })();
        """;

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        UpdateMaximizedBounds();
    }

    protected override void OnLocationChanged(EventArgs e)
    {
        base.OnLocationChanged(e);
        UpdateMaximizedBounds();
    }

    protected override void WndProc(ref Message message)
    {
        if (customTitlebarEnabled && message.Msg == WmNcHitTest && WindowState != FormWindowState.Maximized)
        {
            base.WndProc(ref message);
            if ((int)message.Result != HtClient)
            {
                return;
            }

            var cursor = PointToClient(new Point(SignedLowWord(message.LParam), SignedHighWord(message.LParam)));
            var left = cursor.X <= ResizeGripSize;
            var right = cursor.X >= ClientSize.Width - ResizeGripSize;
            var top = cursor.Y <= ResizeGripSize;
            var bottom = cursor.Y >= ClientSize.Height - ResizeGripSize;
            message.Result = (IntPtr)(left && top ? HtTopLeft
                : right && top ? HtTopRight
                : left && bottom ? HtBottomLeft
                : right && bottom ? HtBottomRight
                : left ? HtLeft
                : right ? HtRight
                : top ? HtTop
                : bottom ? HtBottom
                : HtClient);
            return;
        }

        base.WndProc(ref message);
    }

    private void UpdateMaximizedBounds()
    {
        if (!customTitlebarEnabled || !IsHandleCreated)
        {
            return;
        }

        MaximizedBounds = Screen.FromHandle(Handle).WorkingArea;
    }

    private static bool TryGetString(JsonElement root, string propertyName, out string value)
    {
        if (root.ValueKind == JsonValueKind.Object
            && root.TryGetProperty(propertyName, out var property)
            && property.ValueKind == JsonValueKind.String)
        {
            value = property.GetString() ?? "";
            return value.Length > 0;
        }

        value = "";
        return false;
    }

    private static bool TryGetBoolean(JsonElement root, string propertyName, out bool value)
    {
        if (root.ValueKind == JsonValueKind.Object
            && root.TryGetProperty(propertyName, out var property)
            && (property.ValueKind == JsonValueKind.True || property.ValueKind == JsonValueKind.False))
        {
            value = property.GetBoolean();
            return true;
        }

        value = false;
        return false;
    }

    private static int GetInt32(JsonElement root, string propertyName)
    {
        if (root.ValueKind == JsonValueKind.Object
            && root.TryGetProperty(propertyName, out var property)
            && property.ValueKind == JsonValueKind.Number
            && property.TryGetInt32(out var value))
        {
            return value;
        }

        return 0;
    }

    private static JsonElement GetOptionalObject(JsonElement root, string propertyName)
    {
        return root.ValueKind == JsonValueKind.Object
            && root.TryGetProperty(propertyName, out var property)
            && property.ValueKind == JsonValueKind.Object
            ? property.Clone()
            : default;
    }

    private static string GetOptionalString(JsonElement root, string propertyName)
    {
        return root.ValueKind == JsonValueKind.Object
            && root.TryGetProperty(propertyName, out var property)
            && property.ValueKind == JsonValueKind.String
            ? property.GetString() ?? ""
            : "";
    }

    private bool IsTrustedMainMessage(string source)
    {
        if (!Uri.TryCreate(source, UriKind.Absolute, out var uri))
        {
            return false;
        }

        return string.Equals(uri.Scheme, HarnessUri.Scheme, StringComparison.OrdinalIgnoreCase)
            && uri.IsLoopback
            && uri.Port == HarnessUri.Port;
    }

    private bool TryNormalizeBrowserUri(string rawUrl, out Uri uri, out string error)
    {
        uri = new Uri("about:blank");
        error = "";
        var candidate = rawUrl.Trim();
        if (candidate.Length == 0)
        {
            error = "URL 为空";
            return false;
        }

        if (string.Equals(candidate, "about:blank", StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }

        if (!candidate.Contains("://", StringComparison.Ordinal))
        {
            candidate = "https://" + candidate;
        }

        if (!Uri.TryCreate(candidate, UriKind.Absolute, out var parsed))
        {
            error = "URL 格式无效";
            return false;
        }

        if (parsed.Scheme == Uri.UriSchemeHttp || parsed.Scheme == Uri.UriSchemeHttps)
        {
            uri = parsed;
            return true;
        }

        if (parsed.Scheme == Uri.UriSchemeFile && IsAllowedLocalBrowserFile(parsed))
        {
            uri = parsed;
            return true;
        }

        error = "只允许 http/https、about:blank，以及工作区或临时目录内的 file 页面";
        return false;
    }

    private bool IsAllowedLocalBrowserFile(Uri uri)
    {
        try
        {
            var fullPath = Path.GetFullPath(uri.LocalPath);
            return IsWithinDirectory(fullPath, workspaceRoot)
                || IsWithinDirectory(fullPath, Path.GetTempPath());
        }
        catch (Exception)
        {
            return false;
        }
    }

    private string ResolveWorkspacePath(string requestPath, bool requireExisting)
    {
        var fullPath = string.IsNullOrWhiteSpace(requestPath)
            ? workspaceRoot
            : Path.GetFullPath(Path.IsPathRooted(requestPath) ? requestPath : Path.Combine(workspaceRoot, requestPath));
        if (!IsWithinDirectory(fullPath, workspaceRoot))
        {
            throw new UnauthorizedAccessException("路径不在当前工作区内：" + fullPath);
        }

        if (requireExisting && !File.Exists(fullPath) && !Directory.Exists(fullPath))
        {
            throw new FileNotFoundException("路径不存在：" + fullPath, fullPath);
        }

        EnsureNoReparsePointEscape(fullPath);
        return fullPath;
    }

    private void EnsureNoReparsePointEscape(string fullPath)
    {
        var root = Path.TrimEndingDirectorySeparator(Path.GetFullPath(workspaceRoot));
        var path = Path.TrimEndingDirectorySeparator(Path.GetFullPath(fullPath));
        if (string.Equals(root, path, StringComparison.OrdinalIgnoreCase))
        {
            return;
        }

        var relative = Path.GetRelativePath(root, path);
        if (relative.StartsWith("..", StringComparison.Ordinal))
        {
            throw new UnauthorizedAccessException("路径不在当前工作区内：" + fullPath);
        }

        var current = root;
        foreach (var segment in relative.Split(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar))
        {
            if (string.IsNullOrWhiteSpace(segment))
            {
                continue;
            }

            current = Path.Combine(current, segment);
            if (!File.Exists(current) && !Directory.Exists(current))
            {
                continue;
            }

            var attributes = File.GetAttributes(current);
            if (attributes.HasFlag(FileAttributes.ReparsePoint))
            {
                throw new UnauthorizedAccessException("为避免越界，本轮不跟随符号链接或目录联接：" + current);
            }
        }
    }

    private static bool IsWithinDirectory(string fullPath, string directory)
    {
        var root = Path.TrimEndingDirectorySeparator(Path.GetFullPath(directory));
        var path = Path.TrimEndingDirectorySeparator(Path.GetFullPath(fullPath));
        return string.Equals(path, root, StringComparison.OrdinalIgnoreCase)
            || path.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)
            || path.StartsWith(root + Path.AltDirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);
    }

    private static bool ContainsBinaryPrefix(string filePath)
    {
        Span<byte> buffer = stackalloc byte[4096];
        using var stream = File.OpenRead(filePath);
        var count = stream.Read(buffer);
        for (var index = 0; index < count; index += 1)
        {
            if (buffer[index] == 0)
            {
                return true;
            }
        }

        return false;
    }

    private static bool IsLikelyBinaryPath(string filePath)
    {
        var extension = Path.GetExtension(filePath).TrimStart('.').ToLowerInvariant();
        return extension is "7z" or "bin" or "bmp" or "class" or "dll" or "exe" or "gif" or "gz" or "ico"
            or "jpeg" or "jpg" or "mp3" or "mp4" or "node" or "pdf" or "png" or "so" or "tar"
            or "ttf" or "wasm" or "webp" or "woff" or "woff2" or "zip" or "zst";
    }

    private static string GuessLanguage(string filePath)
    {
        return Path.GetExtension(filePath).TrimStart('.').ToLowerInvariant() switch
        {
            "cs" => "csharp",
            "css" => "css",
            "html" or "htm" => "html",
            "js" or "mjs" or "cjs" => "javascript",
            "json" or "jsonc" => "json",
            "md" or "markdown" => "markdown",
            "ps1" => "powershell",
            "py" => "python",
            "ts" or "tsx" => "typescript",
            "yaml" or "yml" => "yaml",
            _ => ""
        };
    }

    private static string FileRevision(FileInfo info)
    {
        info.Refresh();
        return $"{info.LastWriteTimeUtc.Ticks:x}-{info.Length:x}";
    }

    private static IEnumerable<string> EnumerateWorkspaceFiles(string root)
    {
        var pending = new Stack<string>();
        pending.Push(root);
        while (pending.Count > 0)
        {
            var directory = pending.Pop();
            IEnumerable<string> entries;
            try
            {
                entries = Directory.EnumerateFileSystemEntries(directory);
            }
            catch (IOException)
            {
                continue;
            }
            catch (UnauthorizedAccessException)
            {
                continue;
            }

            foreach (var entry in entries)
            {
                FileAttributes attributes;
                try
                {
                    attributes = File.GetAttributes(entry);
                }
                catch (IOException)
                {
                    continue;
                }
                catch (UnauthorizedAccessException)
                {
                    continue;
                }

                if (attributes.HasFlag(FileAttributes.ReparsePoint))
                {
                    continue;
                }

                if (attributes.HasFlag(FileAttributes.Directory))
                {
                    if (!IgnoredDirectoryNames.Contains(Path.GetFileName(entry), StringComparer.OrdinalIgnoreCase))
                    {
                        pending.Push(entry);
                    }
                    continue;
                }

                yield return entry;
            }
        }
    }

    private static void CreateWorkspaceFileBackup(string filePath)
    {
        var appRoot = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "DeepSeekHarness");
        var backupRoot = Path.Combine(appRoot, "backups", "workspace-files", DateTime.Now.ToString("yyyyMMdd-HHmmss"));
        Directory.CreateDirectory(backupRoot);
        var backupName = Path.GetFileName(filePath) + "." + Guid.NewGuid().ToString("N")[..8] + ".bak";
        File.Copy(filePath, Path.Combine(backupRoot, backupName), overwrite: false);
    }

    private static void AppendLimited(StringBuilder builder, string text)
    {
        lock (builder)
        {
            if (builder.Length >= TerminalOutputLimit)
            {
                return;
            }

            var remaining = TerminalOutputLimit - builder.Length;
            builder.Append(text.Length <= remaining ? text : text[..remaining]);
        }
    }

    private static int SignedLowWord(IntPtr value)
    {
        return unchecked((short)((long)value & 0xffff));
    }

    private static int SignedHighWord(IntPtr value)
    {
        return unchecked((short)(((long)value >> 16) & 0xffff));
    }

    private static bool IsCustomTitlebarEnabled()
    {
        var mode = Environment.GetEnvironmentVariable("DSH_DESKTOP_TITLEBAR_MODE");
        if (string.Equals(mode, "custom", StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }

        if (string.Equals(mode, "native-panel", StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        var enabled = Environment.GetEnvironmentVariable("DSH_DESKTOP_CUSTOM_TITLEBAR");
        if (string.Equals(enabled, "0", StringComparison.Ordinal)
            || string.Equals(enabled, "false", StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        return true;
    }

    private static string ResolveWorkspaceRoot()
    {
        var configured = Environment.GetEnvironmentVariable("DSH_DESKTOP_WORKSPACE_ROOT");
        if (!string.IsNullOrWhiteSpace(configured))
        {
            var full = Path.GetFullPath(configured);
            if (!Directory.Exists(full))
            {
                throw new DirectoryNotFoundException("DSH_DESKTOP_WORKSPACE_ROOT 指向的目录不存在：" + full);
            }

            return full;
        }

        var userProfile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        var storagePath = Path.Combine(userProfile, ".dsh", "storages", "workspace.json");
        if (File.Exists(storagePath))
        {
            try
            {
                using var document = JsonDocument.Parse(File.ReadAllText(storagePath, Encoding.UTF8));
                var root = document.RootElement;
                if (root.TryGetProperty("global", out var global)
                    && global.TryGetProperty("workspaceIds", out var ids)
                    && ids.ValueKind == JsonValueKind.Array
                    && ids.GetArrayLength() > 0
                    && ids[0].ValueKind == JsonValueKind.String)
                {
                    var workspaceId = ids[0].GetString();
                    if (!string.IsNullOrWhiteSpace(workspaceId)
                        && root.TryGetProperty("tables", out var tables)
                        && tables.TryGetProperty("workspaces", out var workspaces)
                        && workspaces.TryGetProperty(workspaceId, out var workspace)
                        && workspace.TryGetProperty("path", out var pathNode)
                        && pathNode.ValueKind == JsonValueKind.String)
                    {
                        var path = pathNode.GetString();
                        if (!string.IsNullOrWhiteSpace(path) && Directory.Exists(path))
                        {
                            return Path.GetFullPath(path);
                        }
                    }
                }

                if (root.TryGetProperty("tables", out var fallbackTables)
                    && fallbackTables.TryGetProperty("workspaces", out var fallbackWorkspaces)
                    && fallbackWorkspaces.ValueKind == JsonValueKind.Object)
                {
                    foreach (var workspace in fallbackWorkspaces.EnumerateObject())
                    {
                        if (workspace.Value.TryGetProperty("path", out var pathNode)
                            && pathNode.ValueKind == JsonValueKind.String)
                        {
                            var path = pathNode.GetString();
                            if (!string.IsNullOrWhiteSpace(path) && Directory.Exists(path))
                            {
                                return Path.GetFullPath(path);
                            }
                        }
                    }
                }
            }
            catch (JsonException)
            {
            }
            catch (IOException)
            {
            }
            catch (UnauthorizedAccessException)
            {
            }
        }

        var desktop = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
        return Directory.Exists(desktop) ? Path.GetFullPath(desktop) : Path.GetFullPath(userProfile);
    }

    private static Uri ResolveHarnessUri()
    {
        var configured = Environment.GetEnvironmentVariable("DSH_DESKTOP_URL");
        if (string.IsNullOrWhiteSpace(configured))
        {
            return new Uri("http://127.0.0.1:3080/");
        }

        if (!Uri.TryCreate(configured, UriKind.Absolute, out var uri)
            || uri.Scheme != Uri.UriSchemeHttp
            || (uri.Host != "127.0.0.1" && !uri.IsLoopback))
        {
            throw new InvalidOperationException("DSH_DESKTOP_URL 只允许本机 HTTP 地址");
        }

        return uri;
    }

    private static bool IsExternalBackendOnly()
    {
        return string.Equals(
            Environment.GetEnvironmentVariable("DSH_DESKTOP_EXTERNAL_BACKEND_ONLY"),
            "1",
            StringComparison.Ordinal);
    }
}
