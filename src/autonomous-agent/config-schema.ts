import { z } from "zod";

/**
 * Zod schema for the `autonomousAgent` section in openclaw.json.
 *
 * Example configuration:
 * ```json
 * {
 *   "autonomousAgent": {
 *     "enabled": true,
 *     "identity": {
 *       "displayName": "Alex (AI)",
 *       "email": "alex-ai@company.com",
 *       "role": "AI Project Manager",
 *       "timezone": "Europe/Moscow"
 *     },
 *     "vault": {
 *       "masterKeyEnv": "OPENCLAW_VAULT_KEY"
 *     },
 *     "email": {
 *       "enabled": true,
 *       "imap": { "host": "imap.gmail.com", "port": 993 },
 *       "agentEmail": "alex-ai@company.com",
 *       "pollIntervalMs": 300000
 *     },
 *     "recurringTasks": [
 *       {
 *         "id": "morning-digest",
 *         "name": "Morning Digest",
 *         "cron": "0 8 * * 1-5",
 *         "instruction": "Compile a morning digest of all open tasks across services"
 *       },
 *       {
 *         "id": "deadline-monitor",
 *         "name": "Deadline Monitor",
 *         "cron": "0 * * * *",
 *         "instruction": "Check all tasks for approaching deadlines and alert the team"
 *       }
 *     ]
 *   }
 * }
 * ```
 */
export const AutonomousAgentConfigSchema = z
  .object({
    enabled: z.boolean().default(false),

    identity: z
      .object({
        displayName: z.string().min(1),
        email: z.string().email(),
        role: z.string().default("AI Team Member"),
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
      .strict(),

    vault: z
      .object({
        /** Environment variable name containing the master password */
        masterKeyEnv: z.string().default("OPENCLAW_VAULT_KEY"),
        /** Alternative: path to file containing the master password */
        masterKeyFile: z.string().optional(),
      })
      .strict()
      .optional(),

    email: z
      .object({
        enabled: z.boolean().default(false),
        imap: z
          .object({
            host: z.string(),
            port: z.number().int().default(993),
            tls: z.boolean().default(true),
          })
          .strict(),
        credentialLabel: z.string().default("agent-email"),
        pollIntervalMs: z.number().int().min(10_000).default(300_000),
        agentEmail: z.string().email(),
        invitePatterns: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),

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

    webhooks: z
      .object({
        /** Base URL for webhook endpoints */
        baseUrl: z.string().url().optional(),
        /** Secret for webhook signature verification (vault label) */
        defaultSecretLabel: z.string().default("webhook-default-secret"),
      })
      .strict()
      .optional(),

    /** Max concurrent tasks the agent can process */
    maxConcurrentTasks: z.number().int().min(1).default(3),

    /** Auto-register default recurring tasks on first boot */
    autoRegisterDefaults: z.boolean().default(true),
  })
  .strict()
  .optional();

export type AutonomousAgentConfig = z.infer<typeof AutonomousAgentConfigSchema>;
