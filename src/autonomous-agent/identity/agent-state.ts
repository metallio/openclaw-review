import fs from "node:fs/promises";
import path from "node:path";

import type { AgentIdentity, AgentPersistentState, DaemonStatus } from "./types.js";
import { AgentPersistentStateSchema } from "./types.js";

/**
 * AgentStateManager — manages persistent identity and runtime state
 * for the autonomous agent across process restarts.
 *
 * The agent is a long-running daemon that retains its identity,
 * memory, and connection state indefinitely.
 */
export class AgentStateManager {
  private state: AgentPersistentState | null = null;
  private daemonStatus: DaemonStatus = "stopped";
  private bootTimestamp: number = 0;

  constructor(private readonly statePath: string) {}

  /**
   * Loads persisted state from disk, or initializes fresh state.
   */
  async boot(identity: AgentIdentity): Promise<void> {
    this.daemonStatus = "starting";
    this.bootTimestamp = Date.now();

    try {
      const raw = await fs.readFile(this.statePath, "utf8");
      this.state = AgentPersistentStateSchema.parse(JSON.parse(raw));
      // Update identity on boot (allows config changes to take effect)
      this.state.identity = identity;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        this.state = {
          identity,
          memoryAnchors: [],
          connections: [],
          stats: {
            totalTasksCompleted: 0,
            totalTasksFailed: 0,
            uptimeMs: 0,
            totalBoots: 0,
          },
        };
      } else {
        throw err;
      }
    }

    this.state.stats.totalBoots++;
    this.state.stats.lastBootAt = new Date().toISOString();
    this.state.identity.lastActiveAt = new Date().toISOString();

    await this.persist();
    this.daemonStatus = "running";
  }

  /**
   * Graceful shutdown — persists final state.
   */
  async shutdown(): Promise<void> {
    this.daemonStatus = "stopping";

    if (this.state) {
      this.state.stats.uptimeMs += Date.now() - this.bootTimestamp;
      this.state.identity.lastActiveAt = new Date().toISOString();
      await this.persist();
    }

    this.daemonStatus = "stopped";
  }

  /**
   * Records a completed task.
   */
  async recordTaskCompletion(service: string, summary: string, refs: string[] = []): Promise<void> {
    if (!this.state) return;

    this.state.stats.totalTasksCompleted++;
    this.state.identity.lastActiveAt = new Date().toISOString();

    // Add memory anchor
    this.state.memoryAnchors.push({
      id: `mem-${Date.now()}`,
      service,
      summary,
      timestamp: new Date().toISOString(),
      refs,
    });

    // Keep memory anchors bounded (last 1000)
    if (this.state.memoryAnchors.length > 1000) {
      this.state.memoryAnchors = this.state.memoryAnchors.slice(-1000);
    }

    await this.persist();
  }

  /**
   * Records a failed task.
   */
  async recordTaskFailure(): Promise<void> {
    if (!this.state) return;
    this.state.stats.totalTasksFailed++;
    await this.persist();
  }

  /**
   * Updates a service connection status.
   */
  async updateConnection(
    service: string,
    status: "active" | "degraded" | "disconnected",
    vaultTokenId?: string,
  ): Promise<void> {
    if (!this.state) return;

    const existing = this.state.connections.find((c) => c.service === service);
    if (existing) {
      existing.status = status;
      existing.lastCheckedAt = new Date().toISOString();
      if (vaultTokenId) existing.vaultTokenId = vaultTokenId;
    } else {
      this.state.connections.push({
        service,
        status,
        lastCheckedAt: new Date().toISOString(),
        vaultTokenId,
      });
    }

    // Update registered services list
    if (!this.state.identity.registeredServices.includes(service)) {
      this.state.identity.registeredServices.push(service);
    }

    await this.persist();
  }

  /**
   * Retrieves memory anchors relevant to a query.
   */
  getMemoryAnchors(opts?: { service?: string; limit?: number }): AgentPersistentState["memoryAnchors"] {
    if (!this.state) return [];

    let anchors = this.state.memoryAnchors;
    if (opts?.service) {
      anchors = anchors.filter((a) => a.service === opts.service);
    }

    const limit = opts?.limit ?? 50;
    return anchors.slice(-limit);
  }

  /**
   * Returns current agent identity.
   */
  getIdentity(): AgentIdentity | null {
    return this.state?.identity ?? null;
  }

  /**
   * Returns daemon health snapshot.
   */
  getHealthSnapshot(): {
    status: DaemonStatus;
    uptimeMs: number;
    stats: AgentPersistentState["stats"];
    connections: AgentPersistentState["connections"];
  } | null {
    if (!this.state) return null;

    return {
      status: this.daemonStatus,
      uptimeMs: (this.state.stats.uptimeMs ?? 0) + (Date.now() - this.bootTimestamp),
      stats: this.state.stats,
      connections: this.state.connections,
    };
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  private async persist(): Promise<void> {
    if (!this.state) return;
    await fs.mkdir(path.dirname(this.statePath), { recursive: true });
    await fs.writeFile(this.statePath, JSON.stringify(this.state, null, 2), "utf8");
  }
}
