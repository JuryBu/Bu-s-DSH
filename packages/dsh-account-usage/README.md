# DSH Account Usage

这是一个只读、宿主后端持有凭据的账户用量服务。它只向界面返回脱敏快照，不保存 API Key、OAuth token、账户原始响应或会话数据。

## 支持边界

| Provider 标识 | 返回内容 | 数据边界 |
| --- | --- | --- |
| `deepseek-api-key` | 官方 API 余额 | `GET https://api.deepseek.com/user/balance` |
| `openai-codex-oauth` | ChatGPT 套餐、5 小时和周额度 | 当前 OAuth 登录态访问 ChatGPT 内部用量接口；不是公开稳定的第三方账单 API |
| `experimental-windsurf-devin` | Windsurf/Devin 套餐、日/周额度、积分或额外余额 | 当前 DSH Windsurf 登录态访问内部账号状态接口；不同账号或版本可能缺少部分字段 |

DeepSeek 的 `0.00` 是真实余额。ChatGPT 和 Windsurf 的数据只描述本次接口实际返回的字段，缺失字段显示为未知，不推算成零，也不把缓存或派生值冒充官方实时账单。

## 安全与请求规则

- 前端只能访问本机同源的只读 `GET /account-usage/<provider>` 路由。
- API Key 与 OAuth token 仅由宿主后端读取并加入出站请求，永不进入快照。
- HTTP 401/403 返回 `auth_error`，服务端原始错误正文不会透出。
- 普通快照缓存 60 秒；并发或短时间连续手动刷新在 30 秒内复用同一个请求。
- ChatGPT 与 Windsurf 的内部接口可以变化，因此解析器对未知结构关闭失败，不阻塞模型本身使用。

## 快照示例

```js
{
  providerId: "experimental-windsurf-devin",
  connection: "connected",
  availability: "available",
  updatedAt: "2026-08-16T03:00:00.000Z",
  boundary: "authenticated_internal_windsurf_user_status_api",
  balance: null,
  quota: {
    kind: "windsurf",
    planName: "Max",
    billingMode: "quota",
    windows: [
      { id: "daily", label: "每日额度", remainingPercent: 100, usedPercent: 0 },
      { id: "weekly", label: "每周额度", remainingPercent: 55, usedPercent: 45 }
    ],
    overageBalanceMicros: 1670000,
    source: "windsurf_api_key_user_status"
  }
}
```

失败快照额外含不带服务端原文的 `reason`，例如 `timeout`、`http_error`、`auth_error`、`request_error`、`invalid_response` 或 `credential_unavailable`。

## 验证

```powershell
npm.cmd run verify
```

自动测试使用假 fetcher、假状态源和内存时钟，不读取本机凭据。真实验收应另外通过 DSH 设置页的点击链路核对当前账户数据。
