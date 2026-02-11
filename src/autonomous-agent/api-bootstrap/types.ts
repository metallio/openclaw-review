import { z } from "zod";

// ── Service integration state machine ───────────────────────────────────────

export const IntegrationPhaseSchema = z.enum([
  "browser-only",   // Using browser automation exclusively
  "bootstrapping",  // Browser is navigating to obtain API token
  "api-ready",      // API token obtained, transitioning to direct API
  "api-active",     // Operating via API calls (browser no longer used)
  "degraded",       // API failed, temporarily falling back to browser
]);

export type IntegrationPhase = z.infer<typeof IntegrationPhaseSchema>;

// ── Service API profile ─────────────────────────────────────────────────────

export const ServiceApiProfileSchema = z.object({
  service: z.string(),
  phase: IntegrationPhaseSchema,
  /** Base URL for API calls */
  apiBaseUrl: z.string().url().optional(),
  /** Vault entry id for the API token */
  vaultTokenId: z.string().optional(),
  /** Headers to add to every API request */
  defaultHeaders: z.record(z.string(), z.string()).optional(),
  /** Known API endpoints discovered during bootstrap */
  discoveredEndpoints: z.record(z.string(), z.string()).optional(),
  /** Webhook endpoints registered in the service */
  registeredWebhooks: z.array(z.object({
    id: z.string(),
    url: z.string().url(),
    events: z.array(z.string()),
    active: z.boolean(),
  })).optional(),
  /** Timestamp of last successful API call */
  lastApiCallAt: z.string().datetime().optional(),
  /** Number of consecutive API failures */
  consecutiveFailures: z.number().int().default(0),
  /** Max failures before degrading to browser fallback */
  maxFailuresBeforeDegradation: z.number().int().default(5),
});

export type ServiceApiProfile = z.infer<typeof ServiceApiProfileSchema>;

// ── Bootstrap result ────────────────────────────────────────────────────────

export type BootstrapResult = {
  success: boolean;
  token?: string;
  apiBaseUrl?: string;
  discoveredEndpoints?: Record<string, string>;
  error?: string;
};

// ── Service-specific bootstrap strategies ───────────────────────────────────

export type BootstrapStrategy = {
  service: string;
  /** URL patterns for the service's developer/API settings page */
  settingsUrlPatterns: string[];
  /** Browser instructions to navigate and create an API token */
  browserInstructions: string;
  /** How to validate the obtained token works */
  validateToken: (token: string, baseUrl?: string) => Promise<boolean>;
  /** Discover available API endpoints */
  discoverEndpoints?: (token: string, baseUrl?: string) => Promise<Record<string, string>>;
};
