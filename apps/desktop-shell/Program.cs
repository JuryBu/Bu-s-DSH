using System.Diagnostics;
using System.Drawing;
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
    private static readonly Uri HarnessUri = ResolveHarnessUri();
    private readonly WebView2 webView;
    private readonly Panel loadingPanel;
    private readonly Label statusLabel;
    private readonly Button retryButton;
    private readonly HttpClient httpClient = new() { Timeout = TimeSpan.FromSeconds(3) };
    private bool startupRunning;

    public HarnessWindow()
    {
        Text = "DeepSeek Harness";
        StartPosition = FormStartPosition.CenterScreen;
        WindowState = FormWindowState.Maximized;
        MinimumSize = new Size(1024, 700);
        BackColor = Color.FromArgb(20, 20, 22);
        Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);

        webView = new WebView2
        {
            Dock = DockStyle.Fill,
            DefaultBackgroundColor = Color.FromArgb(20, 20, 22)
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
        Controls.Add(loadingPanel);
        loadingPanel.BringToFront();

        Shown += async (_, _) => await StartAsync();
        FormClosed += (_, _) => httpClient.Dispose();
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
        if (webView.CoreWebView2 is not null)
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

        var environment = await CoreWebView2Environment.CreateAsync(
            userDataFolder: userDataFolder,
            options: options);
        await webView.EnsureCoreWebView2Async(environment);

        var core = webView.CoreWebView2
            ?? throw new InvalidOperationException("WebView2 初始化未完成");
        core.Settings.AreDefaultContextMenusEnabled = false;
        core.Settings.AreDevToolsEnabled = false;
        core.Settings.IsStatusBarEnabled = false;
        core.Settings.IsZoomControlEnabled = true;
        core.DocumentTitleChanged += (_, _) => Text = "DeepSeek Harness";
        core.NavigationCompleted += (_, args) =>
        {
            if (args.IsSuccess)
            {
                loadingPanel.Visible = false;
                webView.Focus();
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
