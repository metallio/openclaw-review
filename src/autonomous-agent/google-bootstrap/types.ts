import { z } from "zod";

// ── Google Bootstrap Types ──────────────────────────────────────────────────

export const GoogleCredentialsSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export type GoogleCredentials = z.infer<typeof GoogleCredentialsSchema>;

export const GoogleBootstrapPhaseSchema = z.enum([
  "idle",
  "browser-login",         // Logging into Google via browser
  "generating-app-password", // Creating an App Password for IMAP/SMTP
  "enabling-api",          // Enabling Gmail API / generating OAuth tokens
  "discovering-services",  // Scanning Google Workspace for available services
  "configuring-email",     // Setting up IMAP/SMTP with the generated App Password
  "ready",                 // Bootstrap complete — agent is operational
  "failed",
]);

export type GoogleBootstrapPhase = z.infer<typeof GoogleBootstrapPhaseSchema>;

/**
 * State persisted after successful Google bootstrap.
 * Stored in the vault for subsequent boots.
 */
export const GoogleBootstrapStateSchema = z.object({
  email: z.string().email(),
  displayName: z.string().optional(),
  appPassword: z.string().optional(),
  /** Gmail IMAP auto-configured */
  imapConfigured: z.boolean().default(false),
  /** Gmail SMTP auto-configured */
  smtpConfigured: z.boolean().default(false),
  /** Discovered Google Workspace services */
  discoveredServices: z.array(z.string()).default([]),
  /** Google profile avatar URL */
  avatarUrl: z.string().url().optional(),
  bootstrapCompletedAt: z.string().datetime().optional(),
});

export type GoogleBootstrapState = z.infer<typeof GoogleBootstrapStateSchema>;

// ── Browser instruction sets for each bootstrap phase ───────────────────────

export const GOOGLE_LOGIN_INSTRUCTIONS = `
You are an autonomous agent logging into a Google account.

Steps:
1. You are on the Google sign-in page (accounts.google.com).
2. Enter the email address in the "Email or phone" field.
3. Click "Next".
4. Wait for the password field to appear.
5. Enter the password.
6. Click "Next".
7. If a 2-Step Verification prompt appears, wait for the user to approve it
   (this is expected — the human owner pre-authorizes this).
8. Once you see the Google Account page or Gmail inbox, the login is complete.
9. Extract the display name and avatar URL from the account profile if visible.

Return extracted data as JSON:
  { "loggedIn": "true", "displayName": "...", "avatarUrl": "..." }
`.trim();

export const GOOGLE_APP_PASSWORD_INSTRUCTIONS = `
You are generating a Google App Password for IMAP/SMTP access.

Steps:
1. Navigate to: https://myaccount.google.com/apppasswords
2. If prompted to verify identity, complete the verification.
3. In the "App name" field, enter: "OpenClaw Agent"
4. Click "Create" (or "Generate").
5. A 16-character app password will be displayed (format: xxxx xxxx xxxx xxxx).
6. Copy the ENTIRE password (all 16 characters, spaces included).
7. This password will be stored securely in the vault.

CRITICAL: Extract the generated password exactly as shown.
Return: { "appPassword": "xxxx xxxx xxxx xxxx" }
`.trim();

export const GOOGLE_SERVICES_DISCOVERY_INSTRUCTIONS = `
You are discovering which Google Workspace services are available for this account.

Steps:
1. Navigate to: https://myaccount.google.com
2. Check the Google apps grid (9-dot menu in top-right) for available services.
3. Note which services are accessible: Gmail, Calendar, Drive, Docs, Sheets,
   Meet, Chat, Tasks, Keep, Sites, Admin, etc.
4. Navigate to: https://workspace.google.com/intl/en/features/ if this is
   a Workspace account to check additional services.

Return: { "services": ["gmail", "calendar", "drive", "docs", "sheets", ...] }
`.trim();

// ── Google service IMAP/SMTP constants ──────────────────────────────────────

export const GMAIL_IMAP = {
  host: "imap.gmail.com",
  port: 993,
  tls: true,
} as const;

export const GMAIL_SMTP = {
  host: "smtp.gmail.com",
  port: 587,
  tls: true,
} as const;

// ── Bootstrap events ────────────────────────────────────────────────────────

export type GoogleBootstrapEvent =
  | { type: "phase-changed"; from: GoogleBootstrapPhase; to: GoogleBootstrapPhase }
  | { type: "login-success"; displayName?: string }
  | { type: "app-password-generated" }
  | { type: "email-configured" }
  | { type: "services-discovered"; services: string[] }
  | { type: "bootstrap-complete" }
  | { type: "bootstrap-failed"; phase: GoogleBootstrapPhase; error: string };
