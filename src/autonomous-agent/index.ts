/**
 * Autonomous Agent-Employee Module
 *
 * Transforms OpenClaw from a user-driven AI assistant into an independent
 * business unit — a "digital colleague" with its own identity, credentials,
 * and 24/7 autonomous operation.
 *
 * Getting started — just provide Google credentials:
 * ```json
 * {
 *   "autonomousAgent": {
 *     "enabled": true,
 *     "google": { "email": "bot@company.com", "password": "..." }
 *   }
 * }
 * ```
 *
 * The agent will autonomously:
 *   1. Log into Google via browser (Computer Use)
 *   2. Generate an App Password for IMAP/SMTP
 *   3. Start monitoring Gmail for service invites
 *   4. Accept invites, register in services, obtain API tokens
 *   5. Transition from browser to direct API calls
 *   6. Process tasks from webhooks and cron schedules 24/7
 *
 * Architecture:
 *
 *   ┌────────────────────────────────────────────────────────────────┐
 *   │                  AutonomousAgentOrchestrator                   │
 *   │                                                                │
 *   │  ┌────────────────┐                                           │
 *   │  │ GoogleBootstrap │  ← Login + App Password + Services       │
 *   │  └───────┬────────┘                                           │
 *   │          │ (auto-configures everything below)                  │
 *   │          ▼                                                     │
 *   │  ┌─────────────┐  ┌───────────────┐  ┌──────────────────┐    │
 *   │  │ SecureVault  │  │ AgentIdentity │  │  TaskQueue       │    │
 *   │  │ (AES-256)    │  │ (from Google) │  │  (Priority)      │    │
 *   │  └──────┬───────┘  └───────┬───────┘  └────────┬─────────┘    │
 *   │         │                  │                    │              │
 *   │  ┌──────┴───────┐  ┌──────┴────────┐  ┌───────┴──────────┐   │
 *   │  │ Onboarding   │  │ API Bootstrap │  │ Scheduler        │   │
 *   │  │  Gmail IMAP  │  │ Browser→API   │  │  Webhooks+Cron   │   │
 *   │  │  auto-config │  │ transition    │  │  reactive engine │   │
 *   │  └──────────────┘  └───────────────┘  └──────────────────┘   │
 *   └────────────────────────────────────────────────────────────────┘
 *
 * Key principles:
 *   - Google-first: Just email + password, everything else is auto-derived
 *   - Self-provisioning: Agent registers itself in services via email invites
 *   - Browser → API: Starts with browser automation, graduates to direct API
 *   - Event-driven: Reacts to webhooks and processes tasks from priority queue
 *   - Self-hosted: All credentials encrypted locally with AES-256-GCM
 *   - Long-running: Persistent state across restarts, daemon-mode operation
 */

export { AutonomousAgentOrchestrator } from "./orchestrator.js";
export type { AutonomousAgentConfig } from "./orchestrator.js";

// Google bootstrap
export { GoogleBootstrap } from "./google-bootstrap/index.js";
export type { GoogleCredentials, GoogleBootstrapPhase, GoogleBootstrapState, GoogleBootstrapEvent } from "./google-bootstrap/index.js";

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
