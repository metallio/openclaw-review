import type { SecureVault } from "../vault/vault.js";
import type { BootstrapResult, BootstrapStrategy, IntegrationPhase, ServiceApiProfile } from "./types.js";

/**
 * ApiBootstrapper — manages the transition from browser automation to direct API access.
 *
 * Lifecycle:
 *   browser-only → bootstrapping → api-ready → api-active
 *                                                    ↓ (on failure)
 *                                                degraded → (retry) → api-active
 */
export class ApiBootstrapper {
  private readonly profiles = new Map<string, ServiceApiProfile>();
  private readonly strategies = new Map<string, BootstrapStrategy>();

  constructor(
    private readonly vault: SecureVault,
    private readonly browserNavigate: (url: string, instructions: string) => Promise<BrowserBootstrapResult>,
  ) {}

  /**
   * Registers a bootstrap strategy for a service.
   */
  registerStrategy(strategy: BootstrapStrategy): void {
    this.strategies.set(strategy.service, strategy);
  }

  /**
   * Attempts to obtain an API token for a service using browser automation.
   */
  async bootstrap(service: string): Promise<BootstrapResult> {
    const strategy = this.strategies.get(service);
    if (!strategy) {
      return { success: false, error: `No bootstrap strategy for service: ${service}` };
    }

    const profile = this.getOrCreateProfile(service);
    profile.phase = "bootstrapping";

    try {
      // Navigate to the service's API settings page
      const settingsUrl = strategy.settingsUrlPatterns[0];
      if (!settingsUrl) {
        return { success: false, error: "No settings URL configured" };
      }

      const browserResult = await this.browserNavigate(settingsUrl, strategy.browserInstructions);

      if (!browserResult.success || !browserResult.extractedToken) {
        profile.phase = "browser-only";
        return { success: false, error: browserResult.error ?? "Token extraction failed" };
      }

      const token = browserResult.extractedToken;

      // Validate the token
      const isValid = await strategy.validateToken(token, browserResult.apiBaseUrl);
      if (!isValid) {
        profile.phase = "browser-only";
        return { success: false, error: "Obtained token failed validation" };
      }

      // Discover endpoints if the strategy supports it
      let discoveredEndpoints: Record<string, string> | undefined;
      if (strategy.discoverEndpoints) {
        discoveredEndpoints = await strategy.discoverEndpoints(token, browserResult.apiBaseUrl);
      }

      // Store the token in the vault
      const vaultId = await this.vault.put({
        service,
        kind: "api-token",
        label: `${service}-api-bootstrap`,
        plaintext: token,
      });

      // Update profile
      profile.phase = "api-ready";
      profile.vaultTokenId = vaultId;
      profile.apiBaseUrl = browserResult.apiBaseUrl;
      profile.discoveredEndpoints = discoveredEndpoints;
      this.profiles.set(service, profile);

      return {
        success: true,
        token,
        apiBaseUrl: browserResult.apiBaseUrl,
        discoveredEndpoints,
      };
    } catch (err) {
      profile.phase = "browser-only";
      return { success: false, error: (err as Error).message };
    }
  }

  /**
   * Transitions a service from api-ready to api-active (browser no longer needed).
   */
  activate(service: string): void {
    const profile = this.profiles.get(service);
    if (profile && profile.phase === "api-ready") {
      profile.phase = "api-active";
    }
  }

  /**
   * Records an API call failure. If consecutive failures exceed threshold,
   * degrades to browser fallback.
   */
  recordFailure(service: string): IntegrationPhase {
    const profile = this.profiles.get(service);
    if (!profile) return "browser-only";

    profile.consecutiveFailures++;

    if (profile.consecutiveFailures >= profile.maxFailuresBeforeDegradation) {
      profile.phase = "degraded";
    }

    return profile.phase;
  }

  /**
   * Records a successful API call, resetting the failure counter.
   */
  recordSuccess(service: string): void {
    const profile = this.profiles.get(service);
    if (!profile) return;

    profile.consecutiveFailures = 0;
    profile.lastApiCallAt = new Date().toISOString();

    // If degraded and now succeeding, restore to api-active
    if (profile.phase === "degraded") {
      profile.phase = "api-active";
    }
  }

  /**
   * Gets the current integration phase for a service.
   */
  getPhase(service: string): IntegrationPhase {
    return this.profiles.get(service)?.phase ?? "browser-only";
  }

  /**
   * Gets the full service API profile.
   */
  getProfile(service: string): ServiceApiProfile | undefined {
    return this.profiles.get(service);
  }

  /**
   * Returns the API token for a service (decrypted from vault).
   */
  getToken(service: string): string | null {
    const profile = this.profiles.get(service);
    if (!profile?.vaultTokenId) return null;

    return this.vault.get({
      service,
      kind: "api-token",
      label: `${service}-api-bootstrap`,
    });
  }

  /**
   * Lists all managed service profiles.
   */
  listProfiles(): ServiceApiProfile[] {
    return [...this.profiles.values()];
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  private getOrCreateProfile(service: string): ServiceApiProfile {
    let profile = this.profiles.get(service);
    if (!profile) {
      profile = {
        service,
        phase: "browser-only",
        consecutiveFailures: 0,
        maxFailuresBeforeDegradation: 5,
      };
      this.profiles.set(service, profile);
    }
    return profile;
  }
}

// ── Types ────────────────────────────────────────────────────────────────────

type BrowserBootstrapResult = {
  success: boolean;
  extractedToken?: string;
  apiBaseUrl?: string;
  error?: string;
};
