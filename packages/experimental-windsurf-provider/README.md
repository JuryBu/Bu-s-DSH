# 实验性 Windsurf / Devin Provider 候选包

这是 DeepSeek Harness 的**实验性社区 Provider**，已经接入本项目的候选 DSH 运行时，但不是 Windsurf、Cognition 或 Devin 官方集成。它不读取 Windsurf、Devin、Codex 或其它应用的既有登录文件；用户必须在 DSH 中单独授权，或者单独填写长期 API Key。OAuth 与模型调用依赖社区包 `opencode-windsurf-auth` 暴露的 Windsurf/Devin 接口，接口寿命、订阅权限和账号政策都没有官方保证。

## 默认关闭与启用条件

`ExperimentalFeatureGate` 的默认值是关闭。即使把 `enabled` 设为 `true`，还必须显式传入 `communityRiskAccepted: true`；否则 OAuth、手动 API Key、模型目录刷新和流调用都会在网络动作前拒绝。

关闭或回退时，只需让宿主不再提供启用门禁或重新以默认门禁构造 Provider。此时已保存凭据不会被读取、更不会发起目录或流请求。若要主动移除凭据，`browserOAuth.clear()` 和 `manualApiKey.clear()` 只会删除当前类型匹配的凭据，`clearCredentials()` 则无条件清除这个 Provider 的凭据与目录缓存；删除整个候选包目录即可完全撤回这份源码候选，不影响生产 release。

## 认证边界

浏览器授权与手动 API Key 是两条可以同时存在的独立入口：

| 入口 | 注入接口 | 落点 |
| --- | --- | --- |
| 浏览器授权 | Windsurf 官方备用登录页显示 Firebase token，本地导入页交换长期 API Key | `<credentialId>:browser_oauth` |
| 手动 API Key | `ManualApiKeyEntry.save()` | `<credentialId>:manual_api_key` |

两条入口使用不同的 `CredentialStore` 记录，保存其中一种不会覆盖另一种。`authenticationMode` 只决定目录刷新和流调用读取哪一条记录，不会自动回退到另一种，也不会删除未选中的凭据；宿主改变认证方式时应使用新配置重新构造 Provider。类型专属的 `clear()` 只删除自己的记录，需要无条件回滚时使用 Provider 级 `clearCredentials()`。

已经存在 OAuth 凭据也不能跳过授权页面。每次用户明确选择「重新授权」时，插件都会生成新的随机 `state`，打开本机导入页，再由该页面引导用户打开 Windsurf 官方备用登录页。官方页面把 Firebase token 显示给用户；用户复制到本机导入页后，插件才调用 `RegisterUser` 换取长期 API Key，并只保存长期凭据。原始 Firebase token 不写入磁盘、不出现在状态响应中，也不会回显到浏览器。

包内没有磁盘明文实现。`InMemoryFakeCredentialStore` 只供合成测试使用。`WindowsDpapiCurrentUserCredentialStore` 只接受宿主提供的 `DpapiCurrentUserProtector` 与加密字节记录库：保护器必须声明 `scope: "CurrentUser"` 并采用 Windows DPAPI CurrentUser 范围，记录库只接收保护后的 `Uint8Array`，包本身不处理路径、文件或注册表。

浏览器入口使用 Windsurf 备用登录约定 `redirect_uri=show-auth-token`，不再伪造随机 localhost 回调。DSH 自己的本机导入页只绑定随机 `state` 和五分钟有效期；导入请求必须回到同一个本机 DSH 实例，过期、重复或 state 不匹配都会拒绝。包内仍保留通用 `BrowserOAuthFlow` 安全状态机供独立 Provider 测试和复用，但当前 Windsurf 运行时不使用它的 loopback 回调路线。

每一次 `stream()` 和 `refreshModels()` 都会重新调用插件自己的 `CredentialStore.read()`，解析出当次 API Key 后以 `request.apiKey` 显式注入 transport。过期凭据、没有凭据、门禁关闭、模型不可用或 transport 未配置都会在请求前失败；本包不会只产出一个 settings profile 来假装认证已生效。底层 OAuth、目录、凭据桥和 transport 的异常只会收敛为固定错误码，包内没有日志接口，也不会把 API Key 填入状态、流事件或错误正文。

## 候选插件接线

唯一包入口是 package export `.`，对应 `src/index.js`；主线应从 `@deepseek-harness/experimental-windsurf-provider` 导入 `DEFAULT_EXPERIMENTAL_WINDSURF_PROVIDER_CONFIG` 和 `createExperimentalWindsurfDevinProvider`，不要直接引用包内文件。

默认配置如下，关闭状态下 Provider 不读取凭据，也不调用 OAuth、目录或流适配器：

```json
{
  "enabled": false,
  "communityRiskAccepted": false,
  "authenticationMode": "browser_oauth",
  "credentialId": "experimental-windsurf-devin-provider"
}
```

宿主接线应保持这一个构造入口：

```js
import {
  DEFAULT_EXPERIMENTAL_WINDSURF_PROVIDER_CONFIG,
  ExperimentalFeatureGate,
  WindowsDpapiCurrentUserCredentialStore,
  createExperimentalWindsurfDevinProvider
} from "@deepseek-harness/experimental-windsurf-provider";

const config = {
  ...DEFAULT_EXPERIMENTAL_WINDSURF_PROVIDER_CONFIG,
  ...hostConfig.providers.experimentalWindsurfDevin
};

const credentialStore = new WindowsDpapiCurrentUserCredentialStore({
  encryptedRecordStore,
  currentUserProtector
});

const provider = createExperimentalWindsurfDevinProvider({
  featureGate: new ExperimentalFeatureGate(config),
  authenticationMode: config.authenticationMode,
  credentialId: config.credentialId,
  credentialStore,
  oauthFlow,
  catalogSource,
  capabilityResolver,
  transport
});
```

包要求 Node.js 20 或更高版本，并依赖 `opencode-windsurf-auth@0.3.2` 提供 `RegisterUser`、动态模型目录和 Devin 原生流。宿主注入 DPAPI CurrentUser 保护器、只保存密文的记录库和浏览器启动函数；`CapabilityResolver` 可选，未提供时所有未知能力按仅文本处理。本包不安装 `pi-devin-auth` 或 `pi-windsurf`，也不读取它们的凭据文件。

## 动态目录与能力保守规则

目录源只假设实时 RPC 可提供 `modelUid`、`label` 与 `disabled`。`disabled` 是唯一直接用于可用性的实时字段：`false` 映射为 `available`，`true` 映射为 `unavailable`，缺失时为 `unknown`。

上下文窗口、视觉和推理等级只接受单独注入的 `CapabilityResolver` 返回 `authority: "realtime"` 的证据。没有这类证据时，模型固定映射为 `input: ["text"]`、`contextWindowTokens: null`、`reasoningLevels: ["off"]`。任何静态兼容表或 hint 都不会被当作实时权威使用。每条目录记录保留目录来源、目录观测时间、能力证据等级与能力观测时间。

## 流传输语义

`ProviderTransport` 是可注入接口，不绑定 Pi、DSH、浏览器或具体 HTTP/gRPC 协议。它接收每次调用已解析的 `apiKey` 和同一个 `AbortSignal`，返回异步上游事件；候选包把它收敛为接近 Pi `streamSimple` 的 `start → delta / usage → done | error` 序列。适配层会对卡在 `iterator.next()` 的上游竞争取消信号，并尝试调用迭代器的 `return()` 释放资源。流结束而没有终止事件会明确产生 `missing_terminal_event`，未知结束原因会产生 `invalid_finish_reason`，都不会伪造成功。

这个接口只参考 Pi 自定义 Provider 的原生流式生命周期，以及 `pi-devin-auth` 将其自身流式层接到 Pi `streamSimple` 的公开说明；没有复制 `pi-devin-auth`、`pi-windsurf` 或任何未公开服务协议。`pi-devin-auth` 目前记录为社区 MIT 包 `0.1.2`，其 GitHub API 在本次核对时返回 404；动态目录和接口都可能失效。

## 社区与账号风险

该方向是社区非官方实现。Windsurf、Cognition 或 Devin 可以随时调整账号规则、订阅权限、授权页面、目录 RPC、流协议或风控策略，使用者还可能面临接口失效、限流、账号限制或封禁风险。候选包因此默认关闭；只有主人明确启用实验性 Provider 后才显示授权入口，且始终要求 DSH 内独立登录，不导入其它客户端凭据。

上游参考：

- <https://pi.dev/packages/pi-devin-auth>
- <https://github.com/ktappdev/pi-windsurf>
- <https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/custom-provider.md>

## 验证边界

在工作区根目录运行 `Set-Location 'packages/experimental-windsurf-provider'; npm.cmd run verify`。该命令只运行 Node 内置语法检查与测试，使用伪 token、伪 `RegisterUser`、伪目录、伪 transport、伪凭据和可逆字节变换验证边界；不会打开浏览器、发起网络请求、调用 Windows DPAPI 或写入凭据。只有用户完成真实 Windsurf 登录、动态目录刷新、真实模型流和重启后凭据复用后，才能把对应候选标记为真实链路通过。
