export type CredentialKind = "browser_oauth" | "manual_api_key";
export type AuthenticationMode = CredentialKind;
export type Availability = "available" | "unavailable" | "unknown";
export type ReasoningLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

export interface StoredCredential {
  kind: CredentialKind;
  apiKey: string;
  createdAt: string;
  expiresAt?: string;
}

export interface CredentialSummary {
  configured: boolean;
  mode: CredentialKind | "none" | "not_checked" | "unavailable";
  expiresAt: string | null;
  reason?: string;
}

export interface ProviderAuthenticationStatus extends CredentialSummary {
  selectedMode: AuthenticationMode;
  methods: Record<CredentialKind, CredentialSummary>;
}

export interface CredentialStore {
  read(credentialId: string): Promise<StoredCredential | undefined>;
  write(credentialId: string, credential: StoredCredential): Promise<void>;
  remove(credentialId: string): Promise<void>;
}

export interface EncryptedRecordStore {
  read(credentialId: string): Promise<Uint8Array | undefined>;
  write(credentialId: string, encryptedPayload: Uint8Array): Promise<void>;
  remove(credentialId: string): Promise<void>;
}

export interface DpapiCurrentUserProtector {
  scope: "CurrentUser";
  protectCurrentUser(plaintext: Uint8Array): Promise<Uint8Array>;
  unprotectCurrentUser(encryptedPayload: Uint8Array): Promise<Uint8Array>;
}

export interface BrowserOAuthFlow {
  begin(input: { state: string; signal?: AbortSignal }): Promise<{ authorizationUrl: string; transactionId: string; redirectUri: string }>;
  complete(input: { transactionId: string; callbackParameters: Record<string, string>; redirectUri: string; signal?: AbortSignal }): Promise<{ apiKey: string; expiresAt?: string }>;
  cancel?(input: { transactionId: string; signal?: AbortSignal }): Promise<void>;
}

export interface CatalogSnapshotModel {
  modelUid: string;
  label?: string;
  disabled?: boolean;
  capability?: CapabilityEvidence;
}

export interface CatalogSnapshot {
  source?: string;
  observedAt?: string | Date;
  models: CatalogSnapshotModel[];
}

export interface CapabilityEvidence {
  authority: "realtime" | "static" | "unknown";
  observedAt?: string | Date;
  contextWindowTokens?: number;
  supportsVision?: boolean;
  reasoningLevels?: Exclude<ReasoningLevel, "off">[];
}

export interface CapabilityResolver {
  resolve(input: { modelUid: string; label: string; catalogSource: string; catalogObservedAt: string; signal?: AbortSignal }): Promise<CapabilityEvidence | undefined>;
}

export interface CatalogSource {
  fetch(input: { apiKey: string; signal?: AbortSignal }): Promise<CatalogSnapshot>;
}

export interface ModelRecord {
  modelUid: string;
  label: string;
  availability: Availability;
  contextWindowTokens: number | null;
  input: Array<"text" | "image">;
  reasoningLevels: ReasoningLevel[];
  source: {
    catalog: string;
    catalogObservedAt: string;
    capabilityAuthority: "realtime" | "unknown";
    capabilityObservedAt: string | null;
  };
}

export interface UpstreamUsage {
  inputTokens?: number;
  outputTokens?: number;
}

export type UpstreamStreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "reasoning_delta"; text: string }
  | { type: "tool_call_delta"; toolCall: Record<string, unknown> }
  | { type: "usage"; usage?: UpstreamUsage }
  | { type: "finish"; reason?: "stop" | "length" | "tool_call" | "content_filter"; usage?: UpstreamUsage }
  | { type: "error"; code?: "aborted" | "upstream_rejected" | "upstream_rate_limited" | "upstream_unavailable" };

export interface TransportRequest {
  providerId: string;
  modelUid: string;
  messages: unknown[];
  tools: unknown[];
  apiKey: string;
  signal?: AbortSignal;
}

export interface ProviderTransport {
  stream(request: TransportRequest): AsyncIterable<UpstreamStreamEvent>;
}

export type ProviderStreamEvent =
  | { type: "start"; providerId: string; modelUid: string }
  | { type: "delta"; channel: "text" | "reasoning"; text: string }
  | { type: "delta"; channel: "tool_call"; toolCall: Record<string, unknown> }
  | { type: "usage"; inputTokens: number | null; outputTokens: number | null }
  | { type: "done"; reason: "stop" | "length" | "tool_call" | "content_filter"; usage: { inputTokens: number | null; outputTokens: number | null } }
  | { type: "error"; code: string };

export class ExperimentalFeatureGate {
  constructor(options?: { enabled?: boolean; communityRiskAccepted?: boolean });
  enabled: boolean;
  communityRiskAccepted: boolean;
  isEnabled(): boolean;
  getStatus(): { enabled: boolean; reason: string | null };
  assertEnabled(): void;
}

export class InMemoryFakeCredentialStore implements CredentialStore {
  read(credentialId: string): Promise<StoredCredential | undefined>;
  write(credentialId: string, credential: StoredCredential): Promise<void>;
  remove(credentialId: string): Promise<void>;
}

export class WindowsDpapiCurrentUserCredentialStore implements CredentialStore {
  constructor(options: { encryptedRecordStore: EncryptedRecordStore; currentUserProtector: DpapiCurrentUserProtector });
  read(credentialId: string): Promise<StoredCredential | undefined>;
  write(credentialId: string, credential: StoredCredential): Promise<void>;
  remove(credentialId: string): Promise<void>;
}

export class BrowserOAuthEntry {
  constructor(options: { featureGate: ExperimentalFeatureGate; credentialStore: CredentialStore; credentialId: string; oauthFlow?: BrowserOAuthFlow; clock?: () => Date | string; oauthTimeoutMs?: number });
  start(input: { openBrowser: (url: string, options?: { signal?: AbortSignal }) => void | Promise<void>; signal?: AbortSignal }): Promise<{ authorizationUrl: string; transactionId: string; expiresAt: string }>;
  complete(input: { transactionId: string; callbackParameters?: Record<string, string>; signal?: AbortSignal }): Promise<CredentialSummary>;
  clear(): Promise<boolean>;
  cancel(input: { transactionId: string }): Promise<boolean>;
}

export class ManualApiKeyEntry {
  constructor(options: { featureGate: ExperimentalFeatureGate; credentialStore: CredentialStore; credentialId: string; clock?: () => Date | string });
  save(input: { apiKey: string; expiresAt?: string | Date }): Promise<CredentialSummary>;
  clear(): Promise<boolean>;
}

export class DynamicModelCatalog {
  constructor(options?: { source?: CatalogSource; capabilityResolver?: CapabilityResolver; clock?: () => Date | string; fallbackModels?: CatalogSnapshotModel[] });
  refresh(input: { apiKey: string; signal?: AbortSignal }): Promise<ModelRecord[]>;
  get(modelUid: string): ModelRecord | undefined;
  list(): ModelRecord[];
  getStatus(): { generation: number; lastRefreshAt: string | null; modelCount: number };
  clear(): void;
}

export class ExperimentalWindsurfDevinProvider {
  constructor(options?: {
    featureGate?: ExperimentalFeatureGate;
    credentialStore?: CredentialStore;
    credentialId?: string;
    credentialIds?: { browserOAuth?: string; manualApiKey?: string };
    authenticationMode?: AuthenticationMode;
    oauthFlow?: BrowserOAuthFlow;
    catalogSource?: CatalogSource;
    capabilityResolver?: CapabilityResolver;
    transport?: ProviderTransport;
    clock?: () => Date | string;
    oauthTimeoutMs?: number;
  });
  readonly id: "experimental-windsurf-devin";
  readonly featureGate: ExperimentalFeatureGate;
  readonly authenticationMode: AuthenticationMode;
  readonly browserOAuth: BrowserOAuthEntry;
  readonly manualApiKey: ManualApiKeyEntry;
  getStatus(): Promise<{
    providerId: string;
    experimental: { enabled: boolean; reason: string | null };
    authentication: ProviderAuthenticationStatus;
    catalog: { generation: number; lastRefreshAt: string | null; modelCount: number };
    communityProvider: true;
  }>;
  listModels(): ModelRecord[];
  refreshModels(input?: { signal?: AbortSignal }): Promise<ModelRecord[]>;
  clearCredentials(): Promise<void>;
  stream(input: { modelUid: string; messages?: unknown[]; tools?: unknown[]; signal?: AbortSignal }): AsyncIterable<ProviderStreamEvent>;
}

export const DEFAULT_EXPERIMENTAL_WINDSURF_PROVIDER_CONFIG: Readonly<{
  enabled: false;
  communityRiskAccepted: false;
  authenticationMode: "browser_oauth";
  credentialId: "experimental-windsurf-devin-provider";
}>;

export function createExperimentalWindsurfDevinProvider(options?: ConstructorParameters<typeof ExperimentalWindsurfDevinProvider>[0]): ExperimentalWindsurfDevinProvider;
export function adaptNativeStream(input: { transport: ProviderTransport; request: TransportRequest }): AsyncIterable<ProviderStreamEvent>;
