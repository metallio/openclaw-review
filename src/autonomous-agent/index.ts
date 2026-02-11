/**
 * Autonomous Agent-Employee Module
 *
 * Transforms OpenClaw from a user-driven AI assistant into an independent
 * business unit — a "digital colleague" with its own identity, credentials,
 * and 24/7 autonomous operation.
 *
 * Architecture:
 *
 *   ┌──────────────────────────────────────────────────────────────┐
 *   │                   AutonomousAgentOrchestrator                │
 *   │                                                              │
 *   │  ┌─────────────┐  ┌───────────────┐  ┌──────────────────┐  │
 *   │  │ SecureVault  │  │ AgentIdentity │  │  TaskQueue       │  │
 *   │  │ (AES-256)    │  │ (Persistent)  │  │  (Priority)      │  │
 *   │  └──────┬───────┘  └───────┬───────┘  └────────┬─────────┘  │
 *   │         │                  │                    │            │
 *   │  ┌──────┴───────┐  ┌──────┴────────┐  ┌───────┴──────────┐ │
 *   │  │ Onboarding   │  │ API Bootstrap │  │ Scheduler        │ │
 *   │  │ ┌──────────┐ │  │ Browser→API   │  │ ┌──────────────┐ │ │
 *   │  │ │ Email    │ │  │ transition    │  │ │ Webhooks     │ │ │
 *   │  │ │ Monitor  │ │  │               │  │ │ Receiver     │ │ │
 *   │  │ └──────────┘ │  │ ┌───────────┐ │  │ └──────────────┘ │ │
 *   │  │ ┌──────────┐ │  │ │ Service   │ │  │ ┌──────────────┐ │ │
 *   │  │ │ Invite   │ │  │ │ API       │ │  │ │ Recurring    │ │ │
 *   │  │ │ Detector │ │  │ │ Client    │ │  │ │ Runner       │ │ │
 *   │  │ └──────────┘ │  │ └───────────┘ │  │ └──────────────┘ │ │
 *   │  └──────────────┘  └───────────────┘  └──────────────────┘  │
 *   └──────────────────────────────────────────────────────────────┘
 *
 * Key principles:
 *   - Self-provisioning: Agent can register itself in services via email invites
 *   - Browser → API: Starts with browser automation, graduates to direct API calls
 *   - Event-driven: Reacts to webhooks and processes tasks from a priority queue
 *   - Self-hosted: All credentials encrypted locally, no external data storage
 *   - Long-running: Persistent state across restarts, daemon-mode operation
 */

export { AutonomousAgentOrchestrator } from "./orchestrator.js";
export type { AutonomousAgentConfig } from "./orchestrator.js";

// Subsystem exports
export { SecureVault } from "./vault/index.js";
export { InviteDetector, RegistrationOrchestrator } from "./onboarding/index.js";
export { ApiBootstrapper, ServiceApiClient } from "./api-bootstrap/index.js";
export { BusinessTaskQueue, WebhookReceiver, RecurringRunner } from "./scheduler/index.js";
export { AgentStateManager } from "./identity/index.js";

// Config schema
export { AutonomousAgentConfigSchema } from "./config-schema.js";

// Types
export type { CredentialKind, VaultEntry } from "./vault/index.js";
export type { InviteRecord, OnboardingEvent, EmailMonitorConfig } from "./onboarding/index.js";
export type { IntegrationPhase, ServiceApiProfile, BootstrapStrategy } from "./api-bootstrap/index.js";
export type { BusinessTask, SchedulerEvent, RecurringTaskDef, WebhookRegistration } from "./scheduler/index.js";
export type { AgentIdentity, AgentPersistentState, DaemonStatus } from "./identity/index.js";
