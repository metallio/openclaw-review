import type { BusinessTaskQueue } from "./task-queue.js";
import type { RecurringTaskDef, SchedulerEvent } from "./types.js";

/**
 * RecurringRunner — manages cron-like recurring tasks for the autonomous agent.
 *
 * Provides higher-level business task scheduling on top of the existing
 * OpenClaw CronService. Tasks represent business processes like:
 *   - Check email every 5 minutes
 *   - Generate morning digest at 8am
 *   - Monitor deadlines hourly
 *   - Sync project status daily
 */
export class RecurringRunner {
  private readonly tasks = new Map<string, RecurringTaskDef>();
  private readonly timers = new Map<string, ReturnType<typeof setInterval>>();
  private readonly runningTasks = new Set<string>();
  private readonly listeners: Array<(event: SchedulerEvent) => void> = [];

  constructor(private readonly taskQueue: BusinessTaskQueue) {}

  /**
   * Registers a recurring task.
   */
  add(def: RecurringTaskDef): void {
    this.tasks.set(def.id, def);

    if (def.enabled) {
      this.schedule(def);
    }
  }

  /**
   * Removes a recurring task and cancels its timer.
   */
  remove(id: string): boolean {
    const timer = this.timers.get(id);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(id);
    }
    return this.tasks.delete(id);
  }

  /**
   * Enables or disables a recurring task.
   */
  setEnabled(id: string, enabled: boolean): void {
    const def = this.tasks.get(id);
    if (!def) return;

    def.enabled = enabled;

    if (enabled) {
      this.schedule(def);
    } else {
      const timer = this.timers.get(id);
      if (timer) {
        clearInterval(timer);
        this.timers.delete(id);
      }
    }
  }

  /**
   * Lists all recurring task definitions.
   */
  list(): RecurringTaskDef[] {
    return [...this.tasks.values()];
  }

  /**
   * Triggers a recurring task immediately (outside its schedule).
   */
  triggerNow(id: string): void {
    const def = this.tasks.get(id);
    if (def) {
      this.executeRecurring(def);
    }
  }

  /**
   * Stops all running timers.
   */
  stopAll(): void {
    for (const timer of this.timers.values()) {
      clearInterval(timer);
    }
    this.timers.clear();
  }

  onEvent(listener: (event: SchedulerEvent) => void): () => void {
    this.listeners.push(listener);
    return () => {
      const idx = this.listeners.indexOf(listener);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  private schedule(def: RecurringTaskDef): void {
    // Clear existing timer if any
    const existing = this.timers.get(def.id);
    if (existing) clearInterval(existing);

    const intervalMs = this.cronToIntervalMs(def.cron);

    const timer = setInterval(() => {
      this.executeRecurring(def);
    }, intervalMs);

    this.timers.set(def.id, timer);
  }

  private executeRecurring(def: RecurringTaskDef): void {
    if (def.skipIfRunning && this.runningTasks.has(def.id)) {
      return; // Skip — previous instance still running
    }

    this.runningTasks.add(def.id);

    for (const listener of this.listeners) {
      try {
        listener({ type: "cron-triggered", recurringTaskId: def.id });
      } catch { /* ignore */ }
    }

    const task = this.taskQueue.enqueue({
      name: def.name,
      instruction: def.instruction,
      service: def.service,
      cronExpression: def.cron,
    });

    // Listen for task completion to clear running state
    const unsub = this.taskQueue.onEvent((evt) => {
      if (
        (evt.type === "task-completed" || evt.type === "task-failed") &&
        evt.taskId === task.id
      ) {
        this.runningTasks.delete(def.id);
        unsub();
      }
    });
  }

  /**
   * Simplified cron-to-interval converter.
   * Handles common patterns. For full cron support, integrate with
   * the existing OpenClaw CronService.
   */
  private cronToIntervalMs(cron: string): number {
    // Common shortcuts
    const shortcuts: Record<string, number> = {
      "@hourly": 3_600_000,
      "@daily": 86_400_000,
      "@weekly": 604_800_000,
    };

    if (shortcuts[cron]) return shortcuts[cron];

    // Parse "*/N * * * *" pattern (every N minutes)
    const everyNMinutes = cron.match(/^\*\/(\d+)\s/);
    if (everyNMinutes) {
      return parseInt(everyNMinutes[1]!, 10) * 60_000;
    }

    // Default: every hour
    return 3_600_000;
  }
}
