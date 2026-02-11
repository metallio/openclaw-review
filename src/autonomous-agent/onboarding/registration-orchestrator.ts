import type { InviteRecord, OnboardingEvent, ServiceRegistrationHandler } from "./types.js";
import type { SecureVault } from "../vault/vault.js";
import type { ApiBootstrapper } from "../api-bootstrap/bootstrapper.js";

/**
 * RegistrationOrchestrator — coordinates the full onboarding flow:
 *   1. Receives detected invites
 *   2. Dispatches to browser automation for registration
 *   3. Transitions to API bootstrap once registered
 *   4. Stores obtained credentials in the vault
 */
export class RegistrationOrchestrator {
  private readonly handlers = new Map<string, ServiceRegistrationHandler>();
  private readonly listeners: Array<(event: OnboardingEvent) => void> = [];
  private readonly processingQueue: InviteRecord[] = [];
  private processing = false;

  constructor(
    private readonly vault: SecureVault,
    private readonly apiBootstrapper: ApiBootstrapper,
    private readonly browserNavigate: (url: string, instructions: string) => Promise<BrowserResult>,
  ) {}

  /**
   * Registers a handler for a specific service.
   */
  registerHandler(handler: ServiceRegistrationHandler): void {
    this.handlers.set(handler.service, handler);
  }

  /**
   * Queues an invite for processing.
   */
  async enqueue(invite: InviteRecord): Promise<void> {
    this.processingQueue.push(invite);
    if (!this.processing) {
      await this.processQueue();
    }
  }

  onEvent(listener: (event: OnboardingEvent) => void): () => void {
    this.listeners.push(listener);
    return () => {
      const idx = this.listeners.indexOf(listener);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }

  // ── Queue processing ──────────────────────────────────────────────────────

  private async processQueue(): Promise<void> {
    this.processing = true;

    while (this.processingQueue.length > 0) {
      const invite = this.processingQueue.shift()!;
      await this.processInvite(invite);
    }

    this.processing = false;
  }

  private async processInvite(invite: InviteRecord): Promise<void> {
    const handler = this.handlers.get(invite.service);

    this.emit({
      type: "registration-started",
      inviteId: invite.id,
      service: invite.service,
    });

    try {
      // Step 1: Browser-based registration (accept invite, create account)
      if (invite.inviteUrl && handler?.supportsBrowserRegistration) {
        invite.status = "processing";
        invite.processedAt = new Date().toISOString();

        const result = await this.browserNavigate(
          invite.inviteUrl,
          this.buildRegistrationInstructions(invite.service),
        );

        if (!result.success) {
          throw new Error(`Browser registration failed: ${result.error}`);
        }
      }

      invite.status = "registered";
      this.emit({
        type: "registration-completed",
        inviteId: invite.id,
        service: invite.service,
      });

      // Step 2: API bootstrap (obtain API token from the service)
      if (handler?.supportsApiBootstrap) {
        const tokenResult = await this.apiBootstrapper.bootstrap(invite.service);

        if (tokenResult.token) {
          const vaultEntryId = await this.vault.put({
            service: invite.service,
            kind: "api-token",
            label: `${invite.service}-api`,
            plaintext: tokenResult.token,
          });

          invite.status = "api-ready";
          invite.vaultEntryId = vaultEntryId;
          invite.completedAt = new Date().toISOString();

          this.emit({
            type: "api-bootstrapped",
            inviteId: invite.id,
            service: invite.service,
            vaultEntryId,
          });
        }
      }
    } catch (err) {
      invite.status = "failed";
      invite.error = (err as Error).message;
      invite.completedAt = new Date().toISOString();

      this.emit({
        type: "registration-failed",
        inviteId: invite.id,
        service: invite.service,
        error: invite.error,
      });
    }
  }

  /**
   * Builds browser automation instructions for service registration.
   */
  private buildRegistrationInstructions(service: string): string {
    const baseInstructions = [
      `You are registering as a digital team member in ${service}.`,
      "1. Click the 'Accept Invitation' or 'Join' button on the page.",
      "2. If a sign-up form appears, fill it using the agent's identity (name, email).",
      "3. Complete any onboarding wizard or tour by clicking 'Next'/'Skip'.",
      "4. Navigate to Settings → API / Developer / Integrations section.",
      "5. Generate a new API token or Personal Access Token.",
      "6. Copy the token value — this is the critical output.",
    ];

    return baseInstructions.join("\n");
  }

  private emit(event: OnboardingEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Listener errors must not crash the orchestrator
      }
    }
  }
}

// ── Types ────────────────────────────────────────────────────────────────────

type BrowserResult = {
  success: boolean;
  error?: string;
  extractedData?: Record<string, string>;
};
