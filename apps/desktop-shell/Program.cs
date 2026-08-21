using System.Diagnostics;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Text.Json;
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
    private static readonly Uri HarnessUri = ResolveHarnessUri();
    private readonly WebView2 webView;
    private readonly WebView2 embeddedBrowser;
    private readonly Panel loadingPanel;
    private readonly Label statusLabel;
    private readonly Button retryButton;
    private readonly HttpClient httpClient = new() { Timeout = TimeSpan.FromSeconds(3) };
    private readonly bool customTitlebarEnabled = IsCustomTitlebarEnabled();
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
        embeddedCore.NewWindowRequested += (_, args) =>
        {
            args.Handled = true;
            embeddedCore.Navigate(args.Uri);
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

    private void OnMainWebMessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs args)
    {
        try
        {
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

            if (!string.Equals(type, "dsh.embeddedBrowser.console-errors", StringComparison.Ordinal))
            {
                return;
            }

            var detail = root.Clone();
            await DispatchMainWindowEventAsync("dsh:browser:console-errors", detail.GetRawText());
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

    private string BuildDesktopBridgeScript()
    {
        var bridgeJson = JsonSerializer.Serialize(new
        {
            platform = "win32",
            titlebarMode = customTitlebarEnabled ? "custom" : "native-panel",
            titlebarHeight = DesktopTitlebarHeight,
            capabilities = new
            {
                customTitlebar = customTitlebarEnabled,
                rightWorkspace = true,
                embeddedBrowser = true
            }
        });
        return $$"""
            (() => {
                const bridge = {{bridgeJson}};
                try {
                    Object.defineProperty(window, "__dshDesktop", {
                        value: bridge,
                        writable: true,
                        configurable: true
                    });
                } catch {
                    window.__dshDesktop = bridge;
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
        if (root.TryGetProperty(propertyName, out var property) && property.ValueKind == JsonValueKind.String)
        {
            value = property.GetString() ?? "";
            return value.Length > 0;
        }

        value = "";
        return false;
    }

    private static bool TryGetBoolean(JsonElement root, string propertyName, out bool value)
    {
        if (root.TryGetProperty(propertyName, out var property)
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
        if (root.TryGetProperty(propertyName, out var property)
            && property.ValueKind == JsonValueKind.Number
            && property.TryGetInt32(out var value))
        {
            return value;
        }

        return 0;
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
        return string.Equals(enabled, "1", StringComparison.Ordinal)
            || string.Equals(enabled, "true", StringComparison.OrdinalIgnoreCase);
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
