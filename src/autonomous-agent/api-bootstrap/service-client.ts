import type { SecureVault } from "../vault/vault.js";
import type { ApiBootstrapper } from "./bootstrapper.js";

/**
 * ServiceApiClient — unified HTTP client that routes through either
 * direct API calls or browser fallback depending on the service's
 * current integration phase.
 *
 * This is the abstraction layer that makes the browser→API transition
 * transparent to the rest of the system.
 */
export class ServiceApiClient {
  constructor(
    private readonly bootstrapper: ApiBootstrapper,
    private readonly vault: SecureVault,
    private readonly browserFallback: (url: string, instructions: string) => Promise<string>,
  ) {}

  /**
   * Makes an API request to a service. Automatically uses direct HTTP
   * when an API token is available, falls back to browser otherwise.
   */
  async request(service: string, opts: ApiRequestOptions): Promise<ApiResponse> {
    const phase = this.bootstrapper.getPhase(service);

    if (phase === "api-active" || phase === "api-ready") {
      return this.directApiCall(service, opts);
    }

    // browser-only or degraded — use browser automation
    return this.browserApiCall(service, opts);
  }

  // ── Direct API path ───────────────────────────────────────────────────────

  private async directApiCall(service: string, opts: ApiRequestOptions): Promise<ApiResponse> {
    const profile = this.bootstrapper.getProfile(service);
    const token = this.bootstrapper.getToken(service);

    if (!token || !profile?.apiBaseUrl) {
      // Fallback to browser
      return this.browserApiCall(service, opts);
    }

    const url = `${profile.apiBaseUrl}${opts.path}`;
    const headers: Record<string, string> = {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
      ...profile.defaultHeaders,
      ...opts.headers,
    };

    try {
      const response = await fetch(url, {
        method: opts.method ?? "GET",
        headers,
        body: opts.body ? JSON.stringify(opts.body) : undefined,
        signal: opts.timeoutMs ? AbortSignal.timeout(opts.timeoutMs) : undefined,
      });

      if (response.ok) {
        this.bootstrapper.recordSuccess(service);
      } else if (response.status === 401 || response.status === 403) {
        // Token expired or revoked — degrade
        this.bootstrapper.recordFailure(service);
      }

      const data = await response.json().catch(() => null);

      return {
        ok: response.ok,
        status: response.status,
        data,
        headers: Object.fromEntries(response.headers.entries()),
      };
    } catch (err) {
      this.bootstrapper.recordFailure(service);
      return {
        ok: false,
        status: 0,
        data: null,
        error: (err as Error).message,
      };
    }
  }

  // ── Browser fallback path ─────────────────────────────────────────────────

  private async browserApiCall(service: string, opts: ApiRequestOptions): Promise<ApiResponse> {
    try {
      const instruction = [
        `Navigate to the ${service} web interface.`,
        `Perform the following action: ${opts.method ?? "GET"} ${opts.path}`,
        opts.body ? `With data: ${JSON.stringify(opts.body)}` : "",
        "Extract the result and return it as JSON.",
      ].filter(Boolean).join("\n");

      const resultText = await this.browserFallback(
        `https://${service}.com`, // simplified — real impl uses profile.apiBaseUrl
        instruction,
      );

      return {
        ok: true,
        status: 200,
        data: JSON.parse(resultText),
      };
    } catch (err) {
      return {
        ok: false,
        status: 0,
        data: null,
        error: `Browser fallback failed: ${(err as Error).message}`,
      };
    }
  }
}

// ── Types ────────────────────────────────────────────────────────────────────

export type ApiRequestOptions = {
  path: string;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
};

export type ApiResponse = {
  ok: boolean;
  status: number;
  data: unknown;
  headers?: Record<string, string>;
  error?: string;
};
