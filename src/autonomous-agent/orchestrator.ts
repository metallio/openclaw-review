import path from "node:path";

import type { AgentIdentity } from "./identity/types.js";
import type { EmailMonitorConfig, OnboardingEvent } from "./onboarding/types.js";
import type { RecurringTaskDef, SchedulerEvent } from "./scheduler/types.js";
import { ApiBootstrapper } from "./api-bootstrap/bootstrapper.js";
import { ServiceApiClient } from "./api-bootstrap/service-client.js";
import { AgentStateManager } from "./identity/agent-state.js";
import { InviteDetector } from "./onboarding/invite-detector.js";
import { RegistrationOrchestrator } from "./onboarding/registration-orchestrator.js";
import { RecurringRunner } from "./scheduler/recurring-runner.js";
import { BusinessTaskQueue } from "./scheduler/task-queue.js";
import { WebhookReceiver } from "./scheduler/webhook-receiver.js";
import { SecureVault } from "./vault/vault.js";

export type AutonomousAgentConfig = {
  /** Base directory for agent data (vault, state, etc.) */
  dataDir: string;
  /** Master password for vault encryption */
  masterPassword: string;
  /** Agent identity */
  identity: AgentIdentity;
  /** Email monitoring config (optional) */
  email?: EmailMonitorConfig;
  /** Recurring tasks to register on boot */
  recurringTasks?: RecurringTaskDef[];
  /** Browser navigation function (provided by OpenClaw's existing browser module) */
  browserNavigate?: (url: string, instructions: string) => Promise<{ success: boolean; error?: string; extractedData?: Record<string, string> }>;
};

/**
 * AutonomousAgentOrchestrator — the main entry point that composes
 * all subsystems into a single cohesive autonomous agent.
 *
 * Lifecycle:
 *   1. Initialize vault, identity, and subsystems
 *   2. Start email monitoring and webhook receiver
 *   3. Begin processing incoming invites → onboarding → API bootstrap
 *   4. Run recurring tasks (cron-like)
 *   5. Process webhook events from connected services
 *   6. Maintain persistent state across restarts
 */
export class AutonomousAgentOrchestrator {
  // ── Public subsystem references ─────────────────────────────────────────
  readonly vault: SecureVault;
  readonly stateManager: AgentStateManager;
  readonly taskQueue: BusinessTaskQueue;
  readonly webhookReceiver: WebhookReceiver;
  readonly recurringRunner: RecurringRunner;
  readonly apiBootstrapper: ApiBootstrapper;
  readonly serviceClient: ServiceApiClient;
  readonly inviteDetector: InviteDetector | null;
  readonly registrationOrchestrator: RegistrationOrchestrator;

  private running = false;

  constructor(private readonly config: AutonomousAgentConfig) {
    const dataDir = config.dataDir;

    // Initialize vault
    this.vault = new SecureVault(
      path.join(dataDir, "vault.enc.json"),
      path.join(dataDir, "vault.salt"),
    );

    // Initialize identity/state manager
    this.stateManager = new AgentStateManager(
      path.join(dataDir, "agent-state.json"),
    );

    // Initialize task queue
    this.taskQueue = new BusinessTaskQueue();

    // Initialize webhook receiver
    this.webhookReceiver = new WebhookReceiver(this.vault, this.taskQueue);

    // Initialize recurring runner
    this.recurringRunner = new RecurringRunner(this.taskQueue);

    // Browser function (noop if not provided)
    const browserNav = config.browserNavigate ?? (async () => ({ success: false, error: "No browser available" }));

    // Initialize API bootstrapper
    this.apiBootstrapper = new ApiBootstrapper(
      this.vault,
      async (url, instructions) => {
        const result = await browserNav(url, instructions);
        return {
          success: result.success,
          extractedToken: result.extractedData?.["token"],
          apiBaseUrl: result.extractedData?.["apiBaseUrl"],
          error: result.error,
        };
      },
    );

    // Initialize service API client
    this.serviceClient = new ServiceApiClient(
      this.apiBootstrapper,
      this.vault,
      async (url, instructions) => {
        const result = await browserNav(url, instructions);
        return JSON.stringify(result.extractedData ?? {});
      },
    );

    // Initialize registration orchestrator
    this.registrationOrchestrator = new RegistrationOrchestrator(
      this.vault,
      this.apiBootstrapper,
      async (url, instructions) => {
        return browserNav(url, instructions);
      },
    );

    // Initialize email monitoring (if configured)
    if (config.email?.enabled) {
      this.inviteDetector = new InviteDetector(config.email, this.vault);
    } else {
      this.inviteDetector = null;
    }
  }

  /**
   * Boots the autonomous agent — opens vault, loads state, starts all subsystems.
   */
  async start(): Promise<void> {
    if (this.running) return;

    // 1. Open vault
    await this.vault.open(this.config.masterPassword);

    // 2. Boot identity/state
    await this.stateManager.boot(this.config.identity);

    // 3. Wire up event listeners
    this.wireEvents();

    // 4. Start email monitoring
    this.inviteDetector?.start();

    // 5. Register recurring tasks
    if (this.config.recurringTasks) {
      for (const task of this.config.recurringTasks) {
        this.recurringRunner.add(task);
      }
    }

    // 6. Start task processing loop
    this.startTaskProcessor();

    this.running = true;
  }

  /**
   * Graceful shutdown — stops all subsystems and persists state.
   */
  async stop(): Promise<void> {
    if (!this.running) return;

    this.running = false;
    this.inviteDetector?.stop();
    this.recurringRunner.stopAll();
    await this.stateManager.shutdown();
  }

  /**
   * Returns a health snapshot of the autonomous agent.
   */
  getHealth(): Record<string, unknown> {
    return {
      running: this.running,
      daemon: this.stateManager.getHealthSnapshot(),
      taskQueue: this.taskQueue.snapshot(),
      webhooks: this.webhookReceiver.listRegistrations().length,
      recurringTasks: this.recurringRunner.list().length,
      services: this.apiBootstrapper.listProfiles().map((p) => ({
        service: p.service,
        phase: p.phase,
      })),
    };
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  private wireEvents(): void {
    // When an invite is detected → queue for registration
    this.inviteDetector?.onEvent((event: OnboardingEvent) => {
      if (event.type === "invite-detected") {
        void this.registrationOrchestrator.enqueue(event.invite);
      }
    });

    // When a task completes → update state
    this.taskQueue.onEvent((event: SchedulerEvent) => {
      if (event.type === "task-completed") {
        void this.stateManager.recordTaskCompletion(
          "system",
          event.result ?? "Task completed",
        );
      } else if (event.type === "task-failed") {
        void this.stateManager.recordTaskFailure();
      }
    });
  }

  /**
   * Simple task processing loop.
   * In production, this integrates with OpenClaw's agent runtime
   * to execute tasks via the AI model.
   */
  private startTaskProcessor(): void {
    const processNext = async () => {
      if (!this.running) return;

      const task = this.taskQueue.dequeue();
      if (task) {
        try {
          // In a full integration, this would call:
          //   runEmbeddedPiAgent({ message: task.instruction, ... })
          // For now, mark as completed with a placeholder
          this.taskQueue.complete(task.id, "Processed by autonomous agent");
        } catch (err) {
          this.taskQueue.fail(task.id, (err as Error).message);
        }
      }

      // Check for next task
      if (this.running) {
        setTimeout(processNext, 1000);
      }
    };

    void processNext();
  }
}
