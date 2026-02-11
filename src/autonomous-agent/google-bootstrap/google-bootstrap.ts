import type { SecureVault } from "../vault/vault.js";
import type {
  GoogleBootstrapEvent,
  GoogleBootstrapPhase,
  GoogleBootstrapState,
  GoogleCredentials,
} from "./types.js";
import {
  GMAIL_IMAP,
  GMAIL_SMTP,
  GOOGLE_APP_PASSWORD_INSTRUCTIONS,
  GOOGLE_LOGIN_INSTRUCTIONS,
  GOOGLE_SERVICES_DISCOVERY_INSTRUCTIONS,
} from "./types.js";

/**
 * Browser navigation function provided by the host environment.
 * Maps to OpenClaw's existing Playwright/Computer Use integration.
 */
export type BrowserNavigateFn = (
  url: string,
  instructions: string,
) => Promise<{
  success: boolean;
  error?: string;
  extractedData?: Record<string, string>;
}>;

/**
 * GoogleBootstrap — one-shot bootstrap from Google credentials.
 *
 * Input:  { email, password }
 * Output: Fully configured agent with Gmail IMAP/SMTP, discovered services,
 *         and all credentials stored in the encrypted vault.
 *
 * Flow:
 *   1. Open browser → log into Google
 *   2. Navigate to App Passwords → generate one for IMAP/SMTP
 *   3. Store App Password in vault
 *   4. Auto-configure Gmail IMAP settings (no manual config needed)
 *   5. Discover available Google Workspace services
 *   6. Mark bootstrap complete
 *
 * On subsequent boots, the agent reads stored state from the vault
 * and skips browser entirely.
 */
export class GoogleBootstrap {
  private phase: GoogleBootstrapPhase = "idle";
  private state: GoogleBootstrapState | null = null;
  private readonly listeners: Array<(event: GoogleBootstrapEvent) => void> = [];

  constructor(
    private readonly vault: SecureVault,
    private readonly browserNavigate: BrowserNavigateFn,
  ) {}

  /**
   * Returns the current bootstrap phase.
   */
  getPhase(): GoogleBootstrapPhase {
    return this.phase;
  }

  /**
   * Returns the bootstrap state (null if not yet run).
   */
  getState(): GoogleBootstrapState | null {
    return this.state;
  }

  /**
   * Main entry point: takes Google credentials and bootstraps everything.
   *
   * If a previous bootstrap state exists in the vault, returns it
   * immediately without going through the browser.
   */
  async bootstrap(credentials: GoogleCredentials): Promise<GoogleBootstrapState> {
    // Check if we already have a completed bootstrap state
    const existingState = this.loadExistingState(credentials.email);
    if (existingState) {
      this.state = existingState;
      this.setPhase("ready");
      return existingState;
    }

    // Store the Google password in the vault for future use
    await this.vault.put({
      service: "google",
      kind: "generic",
      label: "google-account-password",
      plaintext: credentials.password,
    });

    this.state = {
      email: credentials.email,
      imapConfigured: false,
      smtpConfigured: false,
      discoveredServices: [],
    };

    try {
      // Phase 1: Browser login
      await this.browserLogin(credentials);

      // Phase 2: Generate App Password
      await this.generateAppPassword();

      // Phase 3: Configure email (IMAP/SMTP)
      await this.configureEmail(credentials.email);

      // Phase 4: Discover services
      await this.discoverServices();

      // Mark complete
      this.state.bootstrapCompletedAt = new Date().toISOString();
      await this.persistState();

      this.setPhase("ready");
      this.emit({ type: "bootstrap-complete" });

      return this.state;
    } catch (err) {
      const error = (err as Error).message;
      this.emit({ type: "bootstrap-failed", phase: this.phase, error });
      this.setPhase("failed");
      throw err;
    }
  }

  /**
   * Returns Gmail IMAP config derived from the bootstrap.
   * Ready to be used by InviteDetector or any email polling system.
   */
  getImapConfig(): {
    host: string;
    port: number;
    tls: boolean;
    user: string;
    appPassword: string;
  } | null {
    if (!this.state?.appPassword || !this.state.imapConfigured) return null;

    return {
      ...GMAIL_IMAP,
      user: this.state.email,
      appPassword: this.state.appPassword,
    };
  }

  /**
   * Returns Gmail SMTP config for sending emails.
   */
  getSmtpConfig(): {
    host: string;
    port: number;
    tls: boolean;
    user: string;
    appPassword: string;
  } | null {
    if (!this.state?.appPassword || !this.state.smtpConfigured) return null;

    return {
      ...GMAIL_SMTP,
      user: this.state.email,
      appPassword: this.state.appPassword,
    };
  }

  onEvent(listener: (event: GoogleBootstrapEvent) => void): () => void {
    this.listeners.push(listener);
    return () => {
      const idx = this.listeners.indexOf(listener);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }

  // ── Phase 1: Browser Login ────────────────────────────────────────────────

  private async browserLogin(credentials: GoogleCredentials): Promise<void> {
    this.setPhase("browser-login");

    const result = await this.browserNavigate(
      "https://accounts.google.com/signin",
      [
        GOOGLE_LOGIN_INSTRUCTIONS,
        "",
        `Email to use: ${credentials.email}`,
        `Password to use: ${credentials.password}`,
      ].join("\n"),
    );

    if (!result.success) {
      throw new Error(`Google login failed: ${result.error ?? "Unknown error"}`);
    }

    // Extract profile info
    if (result.extractedData?.["displayName"]) {
      this.state!.displayName = result.extractedData["displayName"];
    }
    if (result.extractedData?.["avatarUrl"]) {
      this.state!.avatarUrl = result.extractedData["avatarUrl"];
    }

    this.emit({
      type: "login-success",
      displayName: this.state!.displayName,
    });
  }

  // ── Phase 2: Generate App Password ────────────────────────────────────────

  private async generateAppPassword(): Promise<void> {
    this.setPhase("generating-app-password");

    const result = await this.browserNavigate(
      "https://myaccount.google.com/apppasswords",
      GOOGLE_APP_PASSWORD_INSTRUCTIONS,
    );

    if (!result.success || !result.extractedData?.["appPassword"]) {
      throw new Error(
        `App Password generation failed: ${result.error ?? "Could not extract password"}`,
      );
    }

    const appPassword = result.extractedData["appPassword"].replace(/\s/g, "");
    this.state!.appPassword = appPassword;

    // Store in vault
    await this.vault.put({
      service: "google",
      kind: "api-token",
      label: "gmail-app-password",
      plaintext: appPassword,
    });

    this.emit({ type: "app-password-generated" });
  }

  // ── Phase 3: Configure Email ──────────────────────────────────────────────

  private async configureEmail(email: string): Promise<void> {
    this.setPhase("configuring-email");

    // Gmail IMAP/SMTP settings are well-known constants — no browser needed.
    // We just store the credentials in the vault for the email subsystem.

    await this.vault.put({
      service: "agent-email",
      kind: "email-imap",
      label: "agent-email",
      plaintext: JSON.stringify({
        host: GMAIL_IMAP.host,
        port: GMAIL_IMAP.port,
        tls: GMAIL_IMAP.tls,
        user: email,
        password: this.state!.appPassword,
      }),
    });

    await this.vault.put({
      service: "agent-email",
      kind: "email-smtp",
      label: "agent-email-smtp",
      plaintext: JSON.stringify({
        host: GMAIL_SMTP.host,
        port: GMAIL_SMTP.port,
        tls: GMAIL_SMTP.tls,
        user: email,
        password: this.state!.appPassword,
      }),
    });

    this.state!.imapConfigured = true;
    this.state!.smtpConfigured = true;

    this.emit({ type: "email-configured" });
  }

  // ── Phase 4: Discover Services ────────────────────────────────────────────

  private async discoverServices(): Promise<void> {
    this.setPhase("discovering-services");

    const result = await this.browserNavigate(
      "https://myaccount.google.com",
      GOOGLE_SERVICES_DISCOVERY_INSTRUCTIONS,
    );

    if (result.success && result.extractedData?.["services"]) {
      try {
        const services = JSON.parse(result.extractedData["services"]);
        if (Array.isArray(services)) {
          this.state!.discoveredServices = services;
        }
      } catch {
        // If parsing fails, fallback to default Gmail-only
        this.state!.discoveredServices = ["gmail"];
      }
    } else {
      // Minimum: we know Gmail is available because we just configured it
      this.state!.discoveredServices = ["gmail"];
    }

    this.emit({
      type: "services-discovered",
      services: this.state!.discoveredServices,
    });
  }

  // ── State persistence ─────────────────────────────────────────────────────

  /**
   * Loads a previously completed bootstrap state from the vault.
   */
  private loadExistingState(email: string): GoogleBootstrapState | null {
    const raw = this.vault.get({
      service: "google-bootstrap",
      kind: "generic",
      label: `bootstrap-state-${email}`,
    });

    if (!raw) return null;

    try {
      const parsed = JSON.parse(raw) as GoogleBootstrapState;
      if (parsed.bootstrapCompletedAt && parsed.email === email) {
        // Restore app password from vault
        const appPassword = this.vault.get({
          service: "google",
          kind: "api-token",
          label: "gmail-app-password",
        });
        if (appPassword) {
          parsed.appPassword = appPassword;
        }
        return parsed;
      }
    } catch {
      // Corrupted state — re-bootstrap
    }

    return null;
  }

  /**
   * Persists bootstrap state to the vault (without the app password in cleartext).
   */
  private async persistState(): Promise<void> {
    if (!this.state) return;

    // Store state without the actual password (it's in a separate vault entry)
    const stateToStore: GoogleBootstrapState = {
      ...this.state,
      appPassword: undefined, // Don't double-store the password
    };

    await this.vault.put({
      service: "google-bootstrap",
      kind: "generic",
      label: `bootstrap-state-${this.state.email}`,
      plaintext: JSON.stringify(stateToStore),
    });
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private setPhase(phase: GoogleBootstrapPhase): void {
    const from = this.phase;
    this.phase = phase;
    if (from !== phase) {
      this.emit({ type: "phase-changed", from, to: phase });
    }
  }

  private emit(event: GoogleBootstrapEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Listener errors must not crash bootstrap
      }
    }
  }
}
