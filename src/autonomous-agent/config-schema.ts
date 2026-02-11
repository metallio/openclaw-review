import { z } from "zod";

/**
 * Zod schema for the `autonomousAgent` section in openclaw.json.
 *
 * Minimal configuration — just provide Google credentials:
 * ```json
 * {
 *   "autonomousAgent": {
 *     "enabled": true,
 *     "google": {
 *       "email": "alex-ai@company.com",
 *       "password": "your-google-password"
 *     }
 *   }
 * }
 * ```
 *
 * The agent will autonomously:
 *   1. Log into Google via browser
 *   2. Generate an App Password for IMAP/SMTP
 *   3. Configure Gmail email monitoring
 *   4. Discover available Google Workspace services
 *   5. Start monitoring for invites and processing tasks
 *
 * Everything else is auto-derived from the Google account:
 *   - Display name → from Google profile
 *   - Email → from provided credentials
 *   - Avatar → from Google profile picture
 *   - Email monitoring → auto-configured via App Password
 *
 * Full configuration with all optional overrides:
 * ```json
 * {
 *   "autonomousAgent": {
 *     "enabled": true,
 *     "google": {
 *       "email": "alex-ai@company.com",
 *       "password": "your-google-password"
 *     },
 *     "identity": {
 *       "displayName": "Alex (AI)",
 *       "role": "AI Project Manager",
 *       "timezone": "Europe/Moscow"
 *     },
 *     "recurringTasks": [
 *       {
 *         "id": "morning-digest",
 *         "name": "Morning Digest",
 *         "cron": "0 8 * * 1-5",
 *         "instruction": "Собери утренний дайджест"
 *       }
 *     ]
 *   }
 * }
 * ```
 */
export const AutonomousAgentConfigSchema = z
  .object({
    enabled: z.boolean().default(false),

    // ── Primary: Google credentials (the only required field) ──────────────
    google: z
      .object({
        /** Google account email */
        email: z.string().email(),
        /** Google account password (stored encrypted in vault on first run) */
        password: z.string().min(1),
      })
      .strict(),

    // ── Optional: identity overrides (auto-derived from Google if omitted) ─
    identity: z
      .object({
        /** Override display name (default: from Google profile) */
        displayName: z.string().min(1).optional(),
        /** Role descriptor shown in service profiles */
        role: z.string().default("AI Team Member"),
        /** Override avatar URL (default: from Google profile) */
        avatarUrl: z.string().url().optional(),
        timezone: z.string().default("UTC"),
        locale: z.string().default("en"),
        workingHours: z
          .object({
            start: z.string().regex(/^\d{2}:\d{2}$/).default("00:00"),
            end: z.string().regex(/^\d{2}:\d{2}$/).default("23:59"),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),

    // ── Optional: vault master key config ─────────────────────────────────
    vault: z
      .object({
        /** Env var with the master password (default: OPENCLAW_VAULT_KEY) */
        masterKeyEnv: z.string().default("OPENCLAW_VAULT_KEY"),
        /** Alternative: path to file with the master password */
        masterKeyFile: z.string().optional(),
      })
      .strict()
      .optional(),

    // ── Optional: email monitoring overrides ──────────────────────────────
    email: z
      .object({
        /** Poll interval (default: 5 min). Set to 0 to use Google default */
        pollIntervalMs: z.number().int().min(10_000).default(300_000),
        /** Additional invite detection patterns beyond built-in ones */
        extraInvitePatterns: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),

    // ── Optional: recurring tasks ────────────────────────────────────────
    recurringTasks: z
      .array(
        z.object({
          id: z.string(),
          name: z.string(),
          cron: z.string(),
          instruction: z.string(),
          service: z.string().optional(),
          enabled: z.boolean().default(true),
          timezone: z.string().default("UTC"),
          skipIfRunning: z.boolean().default(true),
        }).strict(),
      )
      .optional(),

    // ── Optional: webhook config ─────────────────────────────────────────
    webhooks: z
      .object({
        baseUrl: z.string().url().optional(),
        defaultSecretLabel: z.string().default("webhook-default-secret"),
      })
      .strict()
      .optional(),

    /** Max concurrent tasks (default: 3) */
    maxConcurrentTasks: z.number().int().min(1).default(3),
  })
  .strict()
  .optional();

export type AutonomousAgentConfig = z.infer<typeof AutonomousAgentConfigSchema>;
