import { z } from "zod";

// ── Invite source types ─────────────────────────────────────────────────────

export const InviteSourceSchema = z.enum([
  "email",      // Invite received via email (IMAP polling)
  "webhook",    // Invite delivered via webhook endpoint
  "manual",     // Manually triggered by user
]);

export type InviteSource = z.infer<typeof InviteSourceSchema>;

export const InviteStatusSchema = z.enum([
  "detected",       // Invite found but not yet processed
  "processing",     // Currently handling the invite
  "registered",     // Successfully registered in the service
  "api-ready",      // API token obtained, fully bootstrapped
  "failed",         // Registration failed
]);

export type InviteStatus = z.infer<typeof InviteStatusSchema>;

// ── Invite record ───────────────────────────────────────────────────────────

export const InviteRecordSchema = z.object({
  id: z.string(),
  source: InviteSourceSchema,
  status: InviteStatusSchema,
  service: z.string(),
  inviteUrl: z.string().url().optional(),
  senderEmail: z.string().optional(),
  detectedAt: z.string().datetime(),
  processedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
  error: z.string().optional(),
  /** Vault entry id for the obtained credential */
  vaultEntryId: z.string().optional(),
});

export type InviteRecord = z.infer<typeof InviteRecordSchema>;

// ── Email monitoring config ──────────────────────────────────────────────────

export const EmailMonitorConfigSchema = z.object({
  enabled: z.boolean().default(false),
  /** IMAP connection settings — credentials come from the vault */
  imap: z.object({
    host: z.string(),
    port: z.number().int().default(993),
    tls: z.boolean().default(true),
  }),
  /** Vault label for email credentials */
  credentialLabel: z.string().default("agent-email"),
  /** Polling interval in ms */
  pollIntervalMs: z.number().int().min(10_000).default(300_000), // 5 min
  /** Email address the agent monitors (its own mailbox) */
  agentEmail: z.string().email(),
  /** Patterns to detect invites in email subjects/bodies */
  invitePatterns: z.array(z.string()).default([
    "invited you to",
    "join.*workspace",
    "accept.*invitation",
    "you've been added",
  ]),
});

export type EmailMonitorConfig = z.infer<typeof EmailMonitorConfigSchema>;

// ── Service registration handler ────────────────────────────────────────────

export type ServiceRegistrationHandler = {
  /** Service identifier (e.g., "asana", "jira", "linear") */
  service: string;
  /** URL patterns that identify invites for this service */
  urlPatterns: RegExp[];
  /** Whether this handler can self-register via browser automation */
  supportsBrowserRegistration: boolean;
  /** Whether this handler can bootstrap API access */
  supportsApiBootstrap: boolean;
};

// ── Onboarding events ───────────────────────────────────────────────────────

export type OnboardingEvent =
  | { type: "invite-detected"; invite: InviteRecord }
  | { type: "registration-started"; inviteId: string; service: string }
  | { type: "registration-completed"; inviteId: string; service: string }
  | { type: "api-bootstrapped"; inviteId: string; service: string; vaultEntryId: string }
  | { type: "registration-failed"; inviteId: string; service: string; error: string };
