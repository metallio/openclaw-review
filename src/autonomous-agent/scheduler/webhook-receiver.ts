import { createHmac, timingSafeEqual } from "node:crypto";
import { randomUUID } from "node:crypto";

import type { SecureVault } from "../vault/vault.js";
import type { BusinessTaskQueue } from "./task-queue.js";
import type { SchedulerEvent, WebhookRegistration } from "./types.js";

/**
 * WebhookReceiver — HTTP handler for incoming webhook events from external services.
 *
 * Each service registers its webhooks during onboarding. The receiver:
 *   1. Validates webhook signatures (HMAC)
 *   2. Routes events to the appropriate task handlers
 *   3. Creates BusinessTasks for the agent to process
 */
export class WebhookReceiver {
  private readonly registrations = new Map<string, WebhookRegistration>();
  private readonly eventHandlers = new Map<string, WebhookEventHandler[]>();
  private readonly listeners: Array<(event: SchedulerEvent) => void> = [];

  constructor(
    private readonly vault: SecureVault,
    private readonly taskQueue: BusinessTaskQueue,
  ) {}

  /**
   * Registers a webhook endpoint for a service.
   */
  register(opts: {
    service: string;
    events: string[];
    endpointUrl: string;
    secretVaultId?: string;
  }): WebhookRegistration {
    const registration: WebhookRegistration = {
      id: randomUUID(),
      service: opts.service,
      events: opts.events,
      endpointUrl: opts.endpointUrl,
      secretVaultId: opts.secretVaultId,
      active: true,
      createdAt: new Date().toISOString(),
    };

    this.registrations.set(registration.id, registration);
    return registration;
  }

  /**
   * Registers a handler for a specific service:event pattern.
   */
  on(service: string, eventPattern: string, handler: WebhookEventHandler): void {
    const key = `${service}:${eventPattern}`;
    const handlers = this.eventHandlers.get(key) ?? [];
    handlers.push(handler);
    this.eventHandlers.set(key, handlers);
  }

  /**
   * Handles an incoming webhook request.
   * Called by the gateway HTTP handler.
   */
  async handleIncoming(req: IncomingWebhook): Promise<WebhookHandleResult> {
    // Find matching registration
    const registration = this.findRegistration(req.service, req.event);
    if (!registration) {
      return { accepted: false, reason: "No matching webhook registration" };
    }

    if (!registration.active) {
      return { accepted: false, reason: "Webhook is disabled" };
    }

    // Verify signature if secret is configured
    if (registration.secretVaultId) {
      const isValid = await this.verifySignature(req, registration.secretVaultId);
      if (!isValid) {
        return { accepted: false, reason: "Invalid webhook signature" };
      }
    }

    this.emitEvent({
      type: "webhook-received",
      service: req.service,
      event: req.event,
      payload: req.payload,
    });

    // Check for registered event handlers
    const handlers = this.findHandlers(req.service, req.event);

    if (handlers.length > 0) {
      // Execute handlers — they may create tasks
      for (const handler of handlers) {
        try {
          const instruction = await handler(req.payload, req.event);
          if (instruction) {
            this.taskQueue.enqueue({
              name: `${req.service}:${req.event}`,
              instruction,
              service: req.service,
              triggerEvent: req.event,
              context: req.payload as Record<string, unknown>,
              priority: this.inferPriority(req.event),
            });
          }
        } catch (err) {
          console.error(`[webhook] handler error for ${req.service}:${req.event}:`, err);
        }
      }
    } else {
      // Default: create a generic task for unhandled events
      this.taskQueue.enqueue({
        name: `Handle ${req.service} event: ${req.event}`,
        instruction: [
          `A webhook event was received from ${req.service}.`,
          `Event type: ${req.event}`,
          `Payload: ${JSON.stringify(req.payload, null, 2)}`,
          "Analyze this event and take appropriate action.",
        ].join("\n"),
        service: req.service,
        triggerEvent: req.event,
        context: req.payload as Record<string, unknown>,
      });
    }

    return { accepted: true };
  }

  /**
   * Lists active webhook registrations.
   */
  listRegistrations(service?: string): WebhookRegistration[] {
    const all = [...this.registrations.values()];
    return service ? all.filter((r) => r.service === service) : all;
  }

  onEvent(listener: (event: SchedulerEvent) => void): () => void {
    this.listeners.push(listener);
    return () => {
      const idx = this.listeners.indexOf(listener);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  private findRegistration(service: string, event: string): WebhookRegistration | undefined {
    for (const reg of this.registrations.values()) {
      if (reg.service === service && reg.events.some((e) => e === event || e === "*")) {
        return reg;
      }
    }
    return undefined;
  }

  private findHandlers(service: string, event: string): WebhookEventHandler[] {
    const exact = this.eventHandlers.get(`${service}:${event}`) ?? [];
    const wildcard = this.eventHandlers.get(`${service}:*`) ?? [];
    return [...exact, ...wildcard];
  }

  private async verifySignature(req: IncomingWebhook, secretVaultId: string): Promise<boolean> {
    if (!req.signature) return false;

    const secret = this.vault.get({
      service: "webhook-secrets",
      kind: "webhook-secret",
      label: secretVaultId,
    });

    if (!secret) return false;

    const bodyStr = typeof req.rawBody === "string" ? req.rawBody : JSON.stringify(req.payload);
    const expected = createHmac("sha256", secret).update(bodyStr).digest("hex");

    try {
      return timingSafeEqual(Buffer.from(req.signature), Buffer.from(expected));
    } catch {
      return false;
    }
  }

  private inferPriority(event: string): "critical" | "high" | "normal" | "low" {
    const highPriorityEvents = ["incident", "alert", "urgent", "blocker", "critical"];
    const lowPriorityEvents = ["comment", "label", "archive"];

    const lower = event.toLowerCase();
    if (highPriorityEvents.some((p) => lower.includes(p))) return "high";
    if (lowPriorityEvents.some((p) => lower.includes(p))) return "low";
    return "normal";
  }

  private emitEvent(event: SchedulerEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Don't crash on listener errors
      }
    }
  }
}

// ── Types ────────────────────────────────────────────────────────────────────

export type IncomingWebhook = {
  service: string;
  event: string;
  payload: unknown;
  signature?: string;
  rawBody?: string;
};

export type WebhookHandleResult = {
  accepted: boolean;
  reason?: string;
};

/**
 * Returns an instruction string for the agent, or null to skip.
 */
export type WebhookEventHandler = (payload: unknown, event: string) => Promise<string | null>;
