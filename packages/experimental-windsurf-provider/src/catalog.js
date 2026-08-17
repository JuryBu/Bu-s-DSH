import { ProviderBoundaryError } from "./errors.js";

const reasoningLevels = new Set(["minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);

function normalizeTime(value, code) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) {
    throw new ProviderBoundaryError(code);
  }

  return parsed.toISOString();
}

function requireModelString(value, code) {
  if (typeof value !== "string" || value.length === 0) {
    throw new ProviderBoundaryError(code);
  }

  return value;
}

function normalizeAvailability(disabled) {
  if (disabled === false) {
    return "available";
  }

  if (disabled === true) {
    return "unavailable";
  }

  return "unknown";
}

function normalizeCapabilityEvidence(value, catalogObservedAt) {
  if (!value || value.authority !== "realtime") {
    return {
      authority: "unknown",
      observedAt: null,
      contextWindowTokens: null,
      input: ["text"],
      reasoningLevels: ["off"]
    };
  }

  const contextWindowTokens = Number.isSafeInteger(value.contextWindowTokens) && value.contextWindowTokens > 0
    ? value.contextWindowTokens
    : null;
  const normalizedLevels = Array.isArray(value.reasoningLevels)
    ? [...new Set(value.reasoningLevels.filter((level) => reasoningLevels.has(level)))]
    : [];

  return {
    authority: "realtime",
    observedAt: normalizeTime(value.observedAt ?? catalogObservedAt, "invalid_capability_observed_at"),
    contextWindowTokens,
    input: value.supportsVision === true ? ["text", "image"] : ["text"],
    reasoningLevels: ["off", ...normalizedLevels]
  };
}

function cloneModelRecord(record) {
  return {
    modelUid: record.modelUid,
    label: record.label,
    availability: record.availability,
    contextWindowTokens: record.contextWindowTokens,
    input: [...record.input],
    reasoningLevels: [...record.reasoningLevels],
    source: { ...record.source }
  };
}

export class DynamicModelCatalog {
  #source;
  #capabilityResolver;
  #clock;
  #records = new Map();
  #generation = 0;
  #lastRefreshAt = null;

  constructor({ source, capabilityResolver, clock = () => new Date() } = {}) {
    this.#source = source;
    this.#capabilityResolver = capabilityResolver;
    this.#clock = clock;
  }

  async refresh({ apiKey, signal } = {}) {
    if (!this.#source || typeof this.#source.fetch !== "function") {
      throw new ProviderBoundaryError("catalog_source_not_configured");
    }

    if (typeof apiKey !== "string" || apiKey.length === 0) {
      throw new ProviderBoundaryError("invalid_catalog_api_key");
    }

    const snapshot = await this.#source.fetch({ apiKey, signal });
    if (!snapshot || !Array.isArray(snapshot.models)) {
      throw new ProviderBoundaryError("invalid_catalog_snapshot");
    }

    const catalogObservedAt = normalizeTime(snapshot.observedAt ?? this.#clock(), "invalid_catalog_observed_at");
    const catalogSource = typeof snapshot.source === "string" && snapshot.source.length > 0
      ? snapshot.source
      : "injected_catalog_source";
    const records = new Map();

    for (const model of snapshot.models) {
      const modelUid = requireModelString(model?.modelUid, "invalid_model_uid");
      if (records.has(modelUid)) {
        throw new ProviderBoundaryError("duplicate_model_uid");
      }

      const label = typeof model.label === "string" && model.label.length > 0 ? model.label : modelUid;
      const resolvedCapability = this.#capabilityResolver && typeof this.#capabilityResolver.resolve === "function"
        ? await this.#capabilityResolver.resolve({ modelUid, label, catalogSource, catalogObservedAt, signal })
        : undefined;
      const capability = normalizeCapabilityEvidence(resolvedCapability, catalogObservedAt);

      records.set(modelUid, {
        modelUid,
        label,
        availability: normalizeAvailability(model.disabled),
        contextWindowTokens: capability.contextWindowTokens,
        input: capability.input,
        reasoningLevels: capability.reasoningLevels,
        source: {
          catalog: catalogSource,
          catalogObservedAt,
          capabilityAuthority: capability.authority,
          capabilityObservedAt: capability.observedAt
        }
      });
    }

    this.#records = records;
    this.#generation += 1;
    this.#lastRefreshAt = catalogObservedAt;
    return this.list();
  }

  get(modelUid) {
    const record = this.#records.get(modelUid);
    return record ? cloneModelRecord(record) : undefined;
  }

  list() {
    return [...this.#records.values()]
      .map((record) => cloneModelRecord(record))
      .sort((left, right) => left.modelUid.localeCompare(right.modelUid));
  }

  getStatus() {
    return {
      generation: this.#generation,
      lastRefreshAt: this.#lastRefreshAt,
      modelCount: this.#records.size
    };
  }

  clear() {
    const changed = this.#records.size > 0 || this.#lastRefreshAt !== null;
    this.#records.clear();
    this.#lastRefreshAt = null;
    if (changed) {
      this.#generation += 1;
    }
  }
}
