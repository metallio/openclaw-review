import path from "node:path";
import type { GoogleCredentials } from "./google-bootstrap/types.js";
import type { AgentIdentity } from "./identity/types.js";
import type { OnboardingEvent } from "./onboarding/types.js";
import type { RecurringTaskDef, SchedulerEvent } from "./scheduler/types.js";
import { ApiBootstrapper } from "./api-bootstrap/bootstrapper.js";
import { ServiceApiClient } from "./api-bootstrap/service-client.js";
import { GoogleBootstrap } from "./google-bootstrap/google-bootstrap.js";
import { GMAIL_IMAP } from "./google-bootstrap/types.js";
import { AgentStateManager } from "./identity/agent-state.js";
import { InviteDetector } from "./onboarding/invite-detector.js";
import { RegistrationOrchestrator } from "./onboarding/registration-orchestrator.js";
import { RecurringRunner } from "./scheduler/recurring-runner.js";
import { BusinessTaskQueue } from "./scheduler/task-queue.js";
import { WebhookReceiver } from "./scheduler/webhook-receiver.js";
import { SecureVault } from "./vault/vault.js";

/**
 * Callback that executes a business task via the AI runtime.
 *
 * The gateway integration layer wraps `runEmbeddedPiAgent` behind this
 * interface so the orchestrator stays decoupled from the agent runtime.
 */
export type TaskExecutor = (task: {
  instruction: string;
  name: string;
  service?: string;
  context?: Record<string, unknown>;
}) => Promise<{ success: boolean; result?: string; error?: string }>;

export type AutonomousAgentConfig = {
  /** Base directory for agent data (vault, state, etc.) */
  dataDir: string;
  /** Master password for vault encryption */
  masterPassword: string;
  /** Google account credentials — the primary (and only required) input */
  google: GoogleCredentials;
  /** Optional identity overrides (auto-derived from Google if omitted) */
  identityOverrides?: {
    displayName?: string;
    role?: string;
    avatarUrl?: string;
    timezone?: string;
    locale?: string;
    workingHours?: { start: string; end: string };
  };
  /** Email polling overrides */
  emailOverrides?: {
    pollIntervalMs?: number;
    extraInvitePatterns?: string[];
  };
  /** Recurring tasks to register on boot */
  recurringTasks?: RecurringTaskDef[];
  /** Browser navigation function (provided by OpenClaw's existing browser module) */
  browserNavigate?: (
    url: string,
    instructions: string,
  ) => Promise<{ success: boolean; error?: string; extractedData?: Record<string, string> }>;
  /** Task executor — provided by gateway to run tasks through the AI model */
  taskExecutor?: TaskExecutor;
};

/**
 * AutonomousAgentOrchestrator — the main entry point.
 *
 * Simplified lifecycle (Google-first):
 *   1. Open vault
 *   2. Run GoogleBootstrap (login → App Password → IMAP → services)
 *   3. Auto-configure identity from Google profile
 *   4. Start email monitoring with auto-derived IMAP credentials
 *   5. Start task queue, webhooks, and recurring tasks
 *   6. Process incoming invites → onboarding → API bootstrap
 *   7. Persist state across restarts
 *
 * The user only provides: { email, password }. Everything else is automatic.
 */
export class AutonomousAgentOrchestrator {
  // ── Public subsystem references ─────────────────────────────────────────
  readonly vault: SecureVault;
  readonly googleBootstrap: GoogleBootstrap;
  readonly stateManager: AgentStateManager;
  readonly taskQueue: BusinessTaskQueue;
  readonly webhookReceiver: WebhookReceiver;
  readonly recurringRunner: RecurringRunner;
  readonly apiBootstrapper: ApiBootstrapper;
  readonly serviceClient: ServiceApiClient;
  readonly registrationOrchestrator: RegistrationOrchestrator;

  // Created after Google bootstrap completes
  inviteDetector: InviteDetector | null = null;

  private running = false;

  constructor(private readonly config: AutonomousAgentConfig) {
    const dataDir = config.dataDir;

    // Browser function (noop if not provided)
    const browserNav =
      config.browserNavigate ?? (async () => ({ success: false, error: "No browser available" }));

    // Initialize vault
    this.vault = new SecureVault(
      path.join(dataDir, "vault.enc.json"),
      path.join(dataDir, "vault.salt"),
    );

    // Initialize Google bootstrap
    this.googleBootstrap = new GoogleBootstrap(this.vault, browserNav);

    // Initialize identity/state manager
    this.stateManager = new AgentStateManager(path.join(dataDir, "agent-state.json"));

    // Initialize task queue
    this.taskQueue = new BusinessTaskQueue();

    // Initialize webhook receiver
    this.webhookReceiver = new WebhookReceiver(this.vault, this.taskQueue);

    // Initialize recurring runner
    this.recurringRunner = new RecurringRunner(this.taskQueue);

    // Initialize API bootstrapper
    this.apiBootstrapper = new ApiBootstrapper(this.vault, async (url, instructions) => {
      const result = await browserNav(url, instructions);
      return {
        success: result.success,
        extractedToken: result.extractedData?.["token"],
        apiBaseUrl: result.extractedData?.["apiBaseUrl"],
        error: result.error,
      };
    });

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
      async (url, instructions) => browserNav(url, instructions),
    );
  }

  /**
   * Boots the autonomous agent.
   *
   * Full sequence:
   *   1. Open vault
   *   2. Google bootstrap (browser login → App Password → auto-configure)
   *   3. Build identity from Google profile + overrides
   *   4. Start email monitoring (auto-configured IMAP)
   *   5. Wire events, start recurring tasks, begin task processing
   */
  async start(): Promise<void> {
    if (this.running) {
      return;
    }

    // 1. Open vault
    await this.vault.open(this.config.masterPassword);

    // 2. Google bootstrap — this is the magic step
    const googleState = await this.googleBootstrap.bootstrap(this.config.google);

    // 3. Build identity from Google profile + optional overrides
    const overrides = this.config.identityOverrides;
    const identity: AgentIdentity = {
      instanceId: `agent-${Date.now()}`,
      displayName:
        overrides?.displayName ??
        googleState.displayName ??
        this.config.google.email.split("@")[0]!,
      email: this.config.google.email,
      role: overrides?.role ?? "AI Team Member",
      avatarUrl: overrides?.avatarUrl ?? googleState.avatarUrl,
      timezone: overrides?.timezone ?? "UTC",
      locale: overrides?.locale ?? "en",
      workingHours: overrides?.workingHours ?? { start: "00:00", end: "23:59" },
      registeredServices: googleState.discoveredServices,
      createdAt: new Date().toISOString(),
    };

    // 4. Boot identity/state
    await this.stateManager.boot(identity);

    // 5. Auto-configure email monitoring from Google bootstrap
    if (googleState.imapConfigured && googleState.appPassword) {
      const defaultPatterns = [
        "invited you to",
        "join.*workspace",
        "accept.*invitation",
        "you've been added",
        "приглашает вас",
        "присоединиться",
      ];
      const extraPatterns = this.config.emailOverrides?.extraInvitePatterns ?? [];

      this.inviteDetector = new InviteDetector(
        {
          enabled: true,
          imap: GMAIL_IMAP,
          credentialLabel: "agent-email",
          pollIntervalMs: this.config.emailOverrides?.pollIntervalMs ?? 300_000,
          agentEmail: this.config.google.email,
          invitePatterns: [...defaultPatterns, ...extraPatterns],
        },
        this.vault,
      );
    }

    // 6. Wire up event listeners
    this.wireEvents();

    // 7. Start email monitoring
    this.inviteDetector?.start();

    // 8. Register recurring tasks
    if (this.config.recurringTasks) {
      for (const task of this.config.recurringTasks) {
        this.recurringRunner.add(task);
      }
    }

    // 9. Start task processing loop
    this.startTaskProcessor();

    this.running = true;
  }

  /**
   * Graceful shutdown — stops all subsystems and persists state.
   */
  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }

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
      googleBootstrap: this.googleBootstrap.getPhase(),
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
        void this.stateManager.recordTaskCompletion("system", event.result ?? "Task completed");
      } else if (event.type === "task-failed") {
        void this.stateManager.recordTaskFailure();
      }
    });
  }

  /**
   * Task processing loop — dequeues tasks and executes them via the
   * configured TaskExecutor (backed by runEmbeddedPiAgent in production).
   */
  private startTaskProcessor(): void {
    const executor = this.config.taskExecutor;

    const processNext = async () => {
      if (!this.running) {
        return;
      }

      const task = this.taskQueue.dequeue();
      if (task) {
        try {
          if (!executor) {
            this.taskQueue.fail(task.id, "No task executor configured");
          } else {
            const outcome = await executor({
              instruction: task.instruction,
              name: task.name,
              service: task.service,
              context: task.context as Record<string, unknown> | undefined,
            });

            if (outcome.success) {
              this.taskQueue.complete(task.id, outcome.result ?? "Task completed");
            } else {
              this.taskQueue.fail(task.id, outcome.error ?? "Task execution failed");
            }
          }
        } catch (err) {
          this.taskQueue.fail(task.id, (err as Error).message);
        }
      }

      if (this.running) {
        setTimeout(processNext, 1000);
      }
    };

    void processNext();
  }
}
