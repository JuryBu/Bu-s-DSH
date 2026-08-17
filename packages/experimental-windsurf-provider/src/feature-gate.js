import { ProviderBoundaryError } from "./errors.js";

export class ExperimentalFeatureGate {
  constructor({ enabled = false, communityRiskAccepted = false } = {}) {
    this.enabled = enabled === true;
    this.communityRiskAccepted = communityRiskAccepted === true;
  }

  isEnabled() {
    return this.enabled && this.communityRiskAccepted;
  }

  getStatus() {
    if (!this.enabled) {
      return { enabled: false, reason: "experimental_disabled" };
    }

    if (!this.communityRiskAccepted) {
      return { enabled: false, reason: "community_risk_not_accepted" };
    }

    return { enabled: true, reason: null };
  }

  assertEnabled() {
    const status = this.getStatus();
    if (!status.enabled) {
      throw new ProviderBoundaryError(status.reason);
    }
  }
}
