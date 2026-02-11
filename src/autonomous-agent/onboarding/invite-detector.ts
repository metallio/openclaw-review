import { ImapFlow } from "imapflow";
import { randomUUID } from "node:crypto";
import type { SecureVault } from "../vault/vault.js";
import type { EmailMonitorConfig, InviteRecord, OnboardingEvent } from "./types.js";

/**
 * InviteDetector — monitors a mailbox for service invitations.
 *
 * Uses ImapFlow to connect to the agent's IMAP mailbox,
 * fetches unseen messages, and detects invite patterns.
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
    if (!this.config.enabled) {
      return;
    }

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
      if (idx >= 0) {
        this.listeners.splice(idx, 1);
      }
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
   * Fetches unread messages from the agent's mailbox via IMAP.
   */
  private async fetchUnreadMessages(): Promise<EmailMessage[]> {
    const password = this.vault.get({
      service: "agent-email",
      kind: "generic",
      label: this.config.credentialLabel,
    });

    if (!password) {
      console.warn("[onboarding] no email credentials in vault, skipping poll");
      return [];
    }

    const client = new ImapFlow({
      host: this.config.imap.host,
      port: this.config.imap.port,
      secure: this.config.imap.tls,
      auth: { user: this.config.agentEmail, pass: password },
      logger: false,
    });

    const messages: EmailMessage[] = [];

    try {
      await client.connect();
      const lock = await client.getMailboxLock("INBOX");

      try {
        // Only look at unseen messages from the last 7 days
        const since = new Date();
        since.setDate(since.getDate() - 7);

        const seqNos = await client.search({ seen: false, since });
        if (!seqNos.length) {
          return [];
        }

        // Limit to 50 most recent to avoid memory pressure
        const toFetch = seqNos.slice(-50);

        for await (const msg of client.fetch(toFetch, {
          uid: true,
          envelope: true,
          bodyStructure: true,
        })) {
          try {
            const body = await this.downloadTextParts(client, msg.uid, msg.bodyStructure);
            messages.push({
              id: msg.uid.toString(),
              subject: msg.envelope.subject ?? "",
              senderEmail: msg.envelope.from?.[0]?.address ?? "",
              bodyText: body.text,
              bodyHtml: body.html,
              receivedAt: msg.envelope.date ?? new Date(),
            });
          } catch {
            // Skip individual messages that fail to download/parse
          }
        }
      } finally {
        lock.release();
      }
    } finally {
      await client.logout().catch(() => {});
    }

    return messages;
  }

  /**
   * Downloads text/plain and text/html body parts from a message.
   */
  private async downloadTextParts(
    client: ImapFlow,
    uid: number,
    structure: unknown,
  ): Promise<{ text: string; html?: string }> {
    const textPartId = this.findMimePart(structure, "text/plain");
    const htmlPartId = this.findMimePart(structure, "text/html");

    let text = "";
    let html: string | undefined;

    if (textPartId) {
      text = await this.downloadPart(client, uid, textPartId);
    }
    if (htmlPartId) {
      html = await this.downloadPart(client, uid, htmlPartId);
      if (!text) {
        text = html
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim();
      }
    }

    return { text, html };
  }

  /**
   * Downloads and decodes a single MIME part by UID.
   */
  private async downloadPart(client: ImapFlow, uid: number, partId: string): Promise<string> {
    const { content } = await client.download(String(uid), partId, { uid: true });
    const chunks: Buffer[] = [];
    for await (const chunk of content) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString("utf-8");
  }

  /**
   * Walks the MIME body structure tree to find a part by type.
   */
  private findMimePart(structure: unknown, mimeType: string): string | null {
    if (!structure || typeof structure !== "object") {
      return null;
    }

    const s = structure as Record<string, unknown>;
    const type = typeof s.type === "string" ? s.type.toLowerCase() : "";
    const subtype = typeof s.subtype === "string" ? s.subtype.toLowerCase() : "";
    const fullType = subtype ? `${type}/${subtype}` : type;

    if (fullType === mimeType) {
      return typeof s.part === "string" ? s.part : "1";
    }

    if (Array.isArray(s.childNodes)) {
      for (const child of s.childNodes) {
        const found = this.findMimePart(child, mimeType);
        if (found) {
          return found;
        }
      }
    }

    return null;
  }

  /**
   * Analyzes an email message for invite patterns.
   */
  private detectInviteInMessage(msg: EmailMessage): InviteRecord | null {
    const patterns = this.config.invitePatterns.map((p) => new RegExp(p, "i"));
    const searchText = `${msg.subject} ${msg.bodyText}`;

    const isInvite = patterns.some((p) => p.test(searchText));
    if (!isInvite) {
      return null;
    }

    // Extract invite URL from the message
    const urlMatch =
      msg.bodyHtml?.match(/href="(https?:\/\/[^"]+(?:invite|join|accept)[^"]*)"/i) ??
      msg.bodyText?.match(/(https?:\/\/\S+(?:invite|join|accept)\S*)/i);

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
      if (pattern.test(combined)) {
        return service;
      }
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
