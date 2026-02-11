import { z } from "zod";

// ── Agent Identity ──────────────────────────────────────────────────────────

export const AgentIdentitySchema = z.object({
  /** Unique agent instance ID */
  instanceId: z.string(),
  /** Display name used in external services */
  displayName: z.string(),
  /** Agent's dedicated email address */
  email: z.string().email(),
  /** Role descriptor (shown in service profiles) */
  role: z.string().default("AI Team Member"),
  /** Avatar URL for service profiles */
  avatarUrl: z.string().url().optional(),
  /** Timezone the agent operates in */
  timezone: z.string().default("UTC"),
  /** Working hours (for proactive task scheduling) */
  workingHours: z.object({
    start: z.string().regex(/^\d{2}:\d{2}$/).default("00:00"),
    end: z.string().regex(/^\d{2}:\d{2}$/).default("23:59"),
  }).default({ start: "00:00", end: "23:59" }),
  /** Language preferences */
  locale: z.string().default("en"),
  /** Services this agent is registered in */
  registeredServices: z.array(z.string()).default([]),
  /** Agent creation timestamp */
  createdAt: z.string().datetime(),
  /** Last activity timestamp */
  lastActiveAt: z.string().datetime().optional(),
});

export type AgentIdentity = z.infer<typeof AgentIdentitySchema>;

// ── Agent runtime state (persistent across restarts) ────────────────────────

export const AgentPersistentStateSchema = z.object({
  identity: AgentIdentitySchema,
  /** Cumulative session context — agent's "memory" across restarts */
  memoryAnchors: z.array(z.object({
    id: z.string(),
    service: z.string(),
    summary: z.string(),
    timestamp: z.string().datetime(),
    /** References to related tasks/conversations */
    refs: z.array(z.string()).default([]),
  })).default([]),
  /** Active service connections */
  connections: z.array(z.object({
    service: z.string(),
    status: z.enum(["active", "degraded", "disconnected"]),
    lastCheckedAt: z.string().datetime(),
    vaultTokenId: z.string().optional(),
  })).default([]),
  /** Task execution statistics */
  stats: z.object({
    totalTasksCompleted: z.number().int().default(0),
    totalTasksFailed: z.number().int().default(0),
    uptimeMs: z.number().int().default(0),
    lastBootAt: z.string().datetime().optional(),
    totalBoots: z.number().int().default(0),
  }).default({
    totalTasksCompleted: 0,
    totalTasksFailed: 0,
    uptimeMs: 0,
    totalBoots: 0,
  }),
});

export type AgentPersistentState = z.infer<typeof AgentPersistentStateSchema>;

// ── Daemon lifecycle ────────────────────────────────────────────────────────

export type DaemonStatus =
  | "starting"    // Initializing, loading state
  | "running"     // Actively processing tasks
  | "idle"        // Running but no active tasks
  | "stopping"    // Graceful shutdown in progress
  | "stopped";    // Not running
