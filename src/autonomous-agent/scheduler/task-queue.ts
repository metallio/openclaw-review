import { randomUUID } from "node:crypto";

import type { BusinessTask, BusinessTaskPriority, SchedulerEvent } from "./types.js";

/**
 * BusinessTaskQueue — priority queue for agent tasks.
 *
 * Tasks are sorted by priority (critical > high > normal > low),
 * then by creation time (FIFO within same priority).
 */
export class BusinessTaskQueue {
  private readonly queue: BusinessTask[] = [];
  private readonly completed: BusinessTask[] = [];
  private readonly listeners: Array<(event: SchedulerEvent) => void> = [];

  /**
   * Adds a new task to the queue.
   */
  enqueue(opts: {
    name: string;
    instruction: string;
    service?: string;
    priority?: BusinessTaskPriority;
    context?: Record<string, unknown>;
    triggerEvent?: string;
    cronExpression?: string;
    maxRetries?: number;
  }): BusinessTask {
    const task: BusinessTask = {
      id: randomUUID(),
      name: opts.name,
      instruction: opts.instruction,
      service: opts.service,
      priority: opts.priority ?? "normal",
      status: "pending",
      context: opts.context,
      triggerEvent: opts.triggerEvent,
      cronExpression: opts.cronExpression ?? null,
      createdAt: new Date().toISOString(),
      maxRetries: opts.maxRetries ?? 3,
      retryCount: 0,
    };

    this.insertByPriority(task);
    this.emit({ type: "task-created", task });
    return task;
  }

  /**
   * Dequeues the highest-priority pending task.
   */
  dequeue(): BusinessTask | null {
    const idx = this.queue.findIndex((t) => t.status === "pending");
    if (idx === -1) return null;

    const task = this.queue[idx]!;
    task.status = "running";
    task.startedAt = new Date().toISOString();
    this.emit({ type: "task-started", taskId: task.id });
    return task;
  }

  /**
   * Marks a task as completed.
   */
  complete(taskId: string, result?: string): void {
    const task = this.queue.find((t) => t.id === taskId);
    if (!task) return;

    task.status = "completed";
    task.completedAt = new Date().toISOString();
    task.result = result;

    this.moveToCompleted(task);
    this.emit({ type: "task-completed", taskId, result });
  }

  /**
   * Marks a task as failed. Re-enqueues if retries remain.
   */
  fail(taskId: string, error: string): void {
    const task = this.queue.find((t) => t.id === taskId);
    if (!task) return;

    task.retryCount++;
    const willRetry = task.retryCount < task.maxRetries;

    if (willRetry) {
      task.status = "pending";
      task.error = error;
      // Move to back of same priority level
    } else {
      task.status = "failed";
      task.completedAt = new Date().toISOString();
      task.error = error;
      this.moveToCompleted(task);
    }

    this.emit({ type: "task-failed", taskId, error, willRetry });
  }

  /**
   * Cancels a pending or scheduled task.
   */
  cancel(taskId: string): boolean {
    const task = this.queue.find((t) => t.id === taskId);
    if (!task || task.status === "running") return false;

    task.status = "cancelled";
    this.moveToCompleted(task);
    return true;
  }

  /**
   * Returns current queue state.
   */
  snapshot(): { pending: number; running: number; completed: number; failed: number } {
    const running = this.queue.filter((t) => t.status === "running").length;
    const pending = this.queue.filter((t) => t.status === "pending").length;
    const completed = this.completed.filter((t) => t.status === "completed").length;
    const failed = this.completed.filter((t) => t.status === "failed").length;

    return { pending, running, completed, failed };
  }

  /**
   * Returns all tasks (active + completed).
   */
  allTasks(): readonly BusinessTask[] {
    return [...this.queue, ...this.completed];
  }

  onEvent(listener: (event: SchedulerEvent) => void): () => void {
    this.listeners.push(listener);
    return () => {
      const idx = this.listeners.indexOf(listener);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  private readonly priorityOrder: Record<BusinessTaskPriority, number> = {
    critical: 0,
    high: 1,
    normal: 2,
    low: 3,
  };

  private insertByPriority(task: BusinessTask): void {
    const taskPri = this.priorityOrder[task.priority];
    const insertIdx = this.queue.findIndex(
      (t) => t.status === "pending" && this.priorityOrder[t.priority] > taskPri,
    );

    if (insertIdx === -1) {
      this.queue.push(task);
    } else {
      this.queue.splice(insertIdx, 0, task);
    }
  }

  private moveToCompleted(task: BusinessTask): void {
    const idx = this.queue.indexOf(task);
    if (idx >= 0) {
      this.queue.splice(idx, 1);
      this.completed.push(task);
    }
  }

  private emit(event: SchedulerEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Don't crash on listener errors
      }
    }
  }
}
