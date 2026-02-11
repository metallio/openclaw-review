import { randomUUID } from "node:crypto";

import type { EmailMonitorConfig, InviteRecord, OnboardingEvent } from "./types.js";
import type { SecureVault } from "../vault/vault.js";

/**
 * InviteDetector — monitors a mailbox for service invitations.
 *
 * In production this would use an IMAP client (e.g., imapflow).
 * The core logic here handles pattern matching, deduplication,
 * and invite lifecycle management.
 */
export class InviteDetector {
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private readonly knownInviteIds = new Set<string>();
  private readonly invites: InviteRecord[] = [];
  private readonly listeners: Array<(event: OnboardingEvent) => void> = [];

  constructor(
    private readonly config: EmailMonitorConfig,
    private readonly vault: SecureVault,
  ) {}

  /**
   * Starts polling the agent's email for invitations.
   */
  start(): void {
    if (!this.config.enabled) return;

    this.pollTimer = setInterval(() => {
      void this.poll();
    }, this.config.pollIntervalMs);

    // Initial poll
    void this.poll();
  }

  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  onEvent(listener: (event: OnboardingEvent) => void): () => void {
    this.listeners.push(listener);
    return () => {
      const idx = this.listeners.indexOf(listener);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }

  getInvites(): readonly InviteRecord[] {
    return this.invites;
  }

  /**
   * Manually submit an invite URL for processing.
   */
  async submitInvite(url: string, service: string): Promise<InviteRecord> {
    const invite: InviteRecord = {
      id: randomUUID(),
      source: "manual",
      status: "detected",
      service,
      inviteUrl: url,
      detectedAt: new Date().toISOString(),
    };

    this.invites.push(invite);
    this.emit({ type: "invite-detected", invite });
    return invite;
  }

  // ── Email polling ─────────────────────────────────────────────────────────

  private async poll(): Promise<void> {
    try {
      const messages = await this.fetchUnreadMessages();

      for (const msg of messages) {
        const invite = this.detectInviteInMessage(msg);
        if (invite && !this.knownInviteIds.has(invite.id)) {
          this.knownInviteIds.add(invite.id);
          this.invites.push(invite);
          this.emit({ type: "invite-detected", invite });
        }
      }
    } catch (err) {
      // Log error but don't crash — will retry on next poll
      console.error("[onboarding] email poll failed:", (err as Error).message);
    }
  }

  /**
   * Fetches unread messages from the agent's mailbox.
   * In production, use imapflow or similar IMAP library.
   */
  private async fetchUnreadMessages(): Promise<EmailMessage[]> {
    // Retrieve IMAP credentials from vault
    const password = this.vault.get({
      service: "agent-email",
      kind: "generic",
      label: this.config.credentialLabel,
    });

    if (!password) {
      console.warn("[onboarding] no email credentials in vault, skipping poll");
      return [];
    }

    // IMAP fetch stub — replace with real imapflow integration
    // In a real implementation:
    //   const client = new ImapFlow({ host, port, auth: { user, pass }, secure: tls });
    //   await client.connect();
    //   for await (const msg of client.fetch("INBOX", { unseen: true })) { ... }
    return [];
  }

  /**
   * Analyzes an email message for invite patterns.
   */
  private detectInviteInMessage(msg: EmailMessage): InviteRecord | null {
    const patterns = this.config.invitePatterns.map((p) => new RegExp(p, "i"));
    const searchText = `${msg.subject} ${msg.bodyText}`;

    const isInvite = patterns.some((p) => p.test(searchText));
    if (!isInvite) return null;

    // Extract invite URL from the message
    const urlMatch = msg.bodyHtml?.match(/href="(https?:\/\/[^"]+(?:invite|join|accept)[^"]*)"/i)
      ?? msg.bodyText?.match(/(https?:\/\/\S+(?:invite|join|accept)\S*)/i);

    const inviteUrl = urlMatch?.[1];
    const service = this.detectService(inviteUrl ?? "", msg.senderEmail);

    return {
      id: randomUUID(),
      source: "email",
      status: "detected",
      service,
      inviteUrl,
      senderEmail: msg.senderEmail,
      detectedAt: new Date().toISOString(),
    };
  }

  /**
   * Detects the service from an invite URL or sender domain.
   */
  private detectService(url: string, senderEmail: string): string {
    const servicePatterns: Array<[string, RegExp]> = [
      ["asana", /asana\.com/i],
      ["jira", /atlassian\.(com|net)/i],
      ["linear", /linear\.app/i],
      ["notion", /notion\.so/i],
      ["slack", /slack\.com/i],
      ["trello", /trello\.com/i],
      ["github", /github\.com/i],
      ["gitlab", /gitlab\.com/i],
      ["clickup", /clickup\.com/i],
      ["monday", /monday\.com/i],
    ];

    const combined = `${url} ${senderEmail}`;
    for (const [service, pattern] of servicePatterns) {
      if (pattern.test(combined)) return service;
    }
    return "unknown";
  }

  private emit(event: OnboardingEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Don't let listener errors break the detector
      }
    }
  }
}

// ── Internal types ──────────────────────────────────────────────────────────

type EmailMessage = {
  id: string;
  subject: string;
  senderEmail: string;
  bodyText: string;
  bodyHtml?: string;
  receivedAt: Date;
};
