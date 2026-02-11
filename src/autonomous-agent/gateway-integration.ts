import fs from "node:fs/promises";
import path from "node:path";

import type { AutonomousAgentConfig as ConfigSchemaType } from "./config-schema.js";
import { AutonomousAgentOrchestrator } from "./orchestrator.js";

/**
 * Integrates the Autonomous Agent subsystem into the OpenClaw gateway.
 *
 * Called during gateway startup when `autonomousAgent.enabled` is true.
 *
 * Minimal usage — the user only provides Google credentials:
 * ```json
 * { "autonomousAgent": { "enabled": true, "google": { "email": "...", "password": "..." } } }
 * ```
 *
 * Everything else is auto-configured:
 *   - Identity derived from Google profile
 *   - Gmail IMAP auto-configured via App Password
 *   - Services auto-discovered from Google Workspace
 */
export async function startAutonomousAgent(params: {
  config: NonNullable<ConfigSchemaType>;
  dataDir: string;
  browserNavigate?: (url: string, instructions: string) => Promise<{
    success: boolean;
    error?: string;
    extractedData?: Record<string, string>;
  }>;
  log: (level: string, message: string, data?: Record<string, unknown>) => void;
}): Promise<{
  orchestrator: AutonomousAgentOrchestrator;
  /** Express-compatible route handler for webhook ingress */
  webhookHandler: (req: WebhookRequest, res: WebhookResponse) => Promise<void>;
  /** Shutdown function */
  stop: () => Promise<void>;
}> {
  const { config, dataDir, browserNavigate, log } = params;

  // Resolve master password from env or file
  const masterPassword = await resolveMasterPassword(config.vault);
  if (!masterPassword) {
    throw new Error(
      "Autonomous Agent requires a vault master password. " +
      "Set OPENCLAW_VAULT_KEY env var or configure vault.masterKeyFile.",
    );
  }

  const agentDataDir = path.join(dataDir, "autonomous-agent");

  log("info", "Starting Autonomous Agent with Google bootstrap", {
    email: config.google.email,
  });

  const orchestrator = new AutonomousAgentOrchestrator({
    dataDir: agentDataDir,
    masterPassword,
    google: {
      email: config.google.email,
      password: config.google.password,
    },
    identityOverrides: config.identity ? {
      displayName: config.identity.displayName,
      role: config.identity.role,
      avatarUrl: config.identity.avatarUrl,
      timezone: config.identity.timezone,
      locale: config.identity.locale,
      workingHours: config.identity.workingHours,
    } : undefined,
    emailOverrides: config.email ? {
      pollIntervalMs: config.email.pollIntervalMs,
      extraInvitePatterns: config.email.extraInvitePatterns,
    } : undefined,
    recurringTasks: config.recurringTasks?.map((t) => ({
      id: t.id,
      name: t.name,
      cron: t.cron,
      instruction: t.instruction,
      service: t.service,
      enabled: t.enabled ?? true,
      timezone: t.timezone ?? "UTC",
      skipIfRunning: t.skipIfRunning ?? true,
    })),
    browserNavigate,
  });

  // Listen for bootstrap progress
  orchestrator.googleBootstrap.onEvent((event) => {
    log("info", `Google bootstrap: ${event.type}`, event as unknown as Record<string, unknown>);
  });

  await orchestrator.start();

  log("info", "Autonomous Agent is ready", {
    health: orchestrator.getHealth(),
  });

  // Create webhook handler for gateway HTTP routes
  const webhookHandler = async (req: WebhookRequest, res: WebhookResponse) => {
    try {
      const { service, event } = req.params;
      const result = await orchestrator.webhookReceiver.handleIncoming({
        service,
        event,
        payload: req.body,
        signature: req.headers["x-webhook-signature"] as string | undefined,
        rawBody: req.rawBody,
      });

      if (result.accepted) {
        res.status(200).json({ ok: true });
      } else {
        res.status(400).json({ ok: false, reason: result.reason });
      }
    } catch (err) {
      log("error", "Webhook handler error", { error: (err as Error).message });
      res.status(500).json({ ok: false, error: "Internal error" });
    }
  };

  return {
    orchestrator,
    webhookHandler,
    stop: () => orchestrator.stop(),
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function resolveMasterPassword(
  vault?: { masterKeyEnv?: string; masterKeyFile?: string },
): Promise<string | undefined> {
  const envVar = vault?.masterKeyEnv ?? "OPENCLAW_VAULT_KEY";
  const fromEnv = process.env[envVar];
  if (fromEnv) return fromEnv;

  if (vault?.masterKeyFile) {
    try {
      return (await fs.readFile(vault.masterKeyFile, "utf8")).trim();
    } catch {
      return undefined;
    }
  }

  return undefined;
}

// ── Types (minimal Express-compatible interfaces) ────────────────────────────

type WebhookRequest = {
  params: { service: string; event: string };
  body: unknown;
  headers: Record<string, string | string[] | undefined>;
  rawBody?: string;
};

type WebhookResponse = {
  status: (code: number) => WebhookResponse;
  json: (data: unknown) => void;
};
