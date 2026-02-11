import { z } from "zod";

// ── Business task types ─────────────────────────────────────────────────────

export const BusinessTaskPrioritySchema = z.enum(["critical", "high", "normal", "low"]);
export type BusinessTaskPriority = z.infer<typeof BusinessTaskPrioritySchema>;

export const BusinessTaskStatusSchema = z.enum([
  "pending",
  "scheduled",
  "running",
  "completed",
  "failed",
  "cancelled",
]);
export type BusinessTaskStatus = z.infer<typeof BusinessTaskStatusSchema>;

export const BusinessTaskSchema = z.object({
  id: z.string(),
  /** Human-readable task name */
  name: z.string(),
  /** Service this task relates to (e.g., "asana", "jira") */
  service: z.string().optional(),
  /** Task priority — critical tasks preempt lower ones */
  priority: BusinessTaskPrioritySchema.default("normal"),
  status: BusinessTaskStatusSchema.default("pending"),
  /** The prompt/instruction for the agent to execute */
  instruction: z.string(),
  /** Context data from the triggering event */
  context: z.record(z.string(), z.unknown()).optional(),
  /** Cron expression for recurring tasks (null = one-shot) */
  cronExpression: z.string().nullable().default(null),
  /** Webhook event that triggered this task */
  triggerEvent: z.string().optional(),
  createdAt: z.string().datetime(),
  scheduledAt: z.string().datetime().optional(),
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
  /** Result or error from execution */
  result: z.string().optional(),
  error: z.string().optional(),
  /** Max retries on failure */
  maxRetries: z.number().int().default(3),
  retryCount: z.number().int().default(0),
});

export type BusinessTask = z.infer<typeof BusinessTaskSchema>;

// ── Webhook registration ────────────────────────────────────────────────────

export const WebhookRegistrationSchema = z.object({
  id: z.string(),
  service: z.string(),
  /** The external webhook ID (returned by the service on registration) */
  externalId: z.string().optional(),
  /** Events this webhook listens for */
  events: z.array(z.string()),
  /** Our endpoint URL that receives events */
  endpointUrl: z.string().url(),
  /** Secret for HMAC signature verification */
  secretVaultId: z.string().optional(),
  active: z.boolean().default(true),
  createdAt: z.string().datetime(),
});

export type WebhookRegistration = z.infer<typeof WebhookRegistrationSchema>;

// ── Recurring task definition ───────────────────────────────────────────────

export const RecurringTaskDefSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Cron expression (e.g., "*/5 * * * *" for every 5 min) */
  cron: z.string(),
  /** Agent instruction to execute */
  instruction: z.string(),
  service: z.string().optional(),
  enabled: z.boolean().default(true),
  /** Timezone for cron interpretation */
  timezone: z.string().default("UTC"),
  /** Don't run if previous instance is still running */
  skipIfRunning: z.boolean().default(true),
});

export type RecurringTaskDef = z.infer<typeof RecurringTaskDefSchema>;

// ── Scheduler events ────────────────────────────────────────────────────────

export type SchedulerEvent =
  | { type: "task-created"; task: BusinessTask }
  | { type: "task-started"; taskId: string }
  | { type: "task-completed"; taskId: string; result?: string }
  | { type: "task-failed"; taskId: string; error: string; willRetry: boolean }
  | { type: "webhook-received"; service: string; event: string; payload: unknown }
  | { type: "cron-triggered"; recurringTaskId: string };
