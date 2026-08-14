import fs from 'node:fs/promises';
import path from 'node:path';

import { newMessageId } from '../core/ids.js';
import { errorMessage, NotFoundError, TransportError, ValidationError } from '../core/errors.js';
import { nowIso, sleep } from '../core/time.js';
import { type Agent, type DeliveryTelemetry, type Message, type Task } from '../domain/types.js';
import { ensureDir, pathExists } from '../infra/fs/atomic.js';
import { mailboxPaths } from '../infra/fs/paths.js';
import { resolvePane, type ResolvedPane } from '../infra/tmux/paneResolution.js';
import { getProvider } from '../providers/registry.js';
import { type DispatchContext } from '../providers/types.js';
import { type Workspace } from '../app/workspace.js';
import { isTerminal } from '../app/taskService.js';
import { deliverToPane, DeliveryStageError } from './dispatch.js';
import {
  extractSentinelBlock,
  readResponseFile,
  sameSnapshot,
  snapshotFile,
  type FileSnapshot,
} from './responseCapture.js';

export interface AgentWorkerOptions {
  pollIntervalMs?: number;
  /** How long to wait for a response before failing the task. */
  responseTimeoutMs?: number;
  heartbeatMs?: number;
  /** Run a single poll cycle and return (used by tests and `--once`). */
  once?: boolean;
  logger?: (line: string) => void;
  signal?: AbortSignal;
}

const DEFAULTS = {
  pollIntervalMs: 1_500,
  responseTimeoutMs: 15 * 60_000,
  heartbeatMs: 15_000,
};

/**
 * The `agent` execution mode: polls one mailbox, hands work to the AI client
 * living in the registered tmux session, and publishes results back to the
 * filesystem. It never reads another agent's mailbox.
 */
export class AgentWorker {
  private readonly opts: Required<Omit<AgentWorkerOptions, 'signal' | 'logger' | 'once'>>;
  private readonly log: (line: string) => void;
  private readonly signal: AbortSignal | undefined;
  private readonly once: boolean;
  private lastHeartbeatAt = 0;
  /** Messages already consumed out of band (e.g. a cancel seen while busy). */
  private readonly handled = new Set<string>();
  private stopped = false;

  constructor(
    private readonly workspace: Workspace,
    private readonly agentId: string,
    options: AgentWorkerOptions = {},
  ) {
    this.opts = {
      pollIntervalMs: options.pollIntervalMs ?? DEFAULTS.pollIntervalMs,
      responseTimeoutMs: options.responseTimeoutMs ?? DEFAULTS.responseTimeoutMs,
      heartbeatMs: options.heartbeatMs ?? DEFAULTS.heartbeatMs,
    };
    this.log = options.logger ?? ((line) => console.log(line));
    this.signal = options.signal;
    this.once = options.once ?? false;
  }

  async run(): Promise<void> {
    const agent = await this.workspace.agents.get(this.agentId);
    await this.workspace.agents.ensureMailbox(this.agentId);
    await this.workspace.bus.writeStatus(this.agentId, 'starting', { pid: process.pid });
    await this.workspace.events.emit({
      type: 'runner.started',
      actor: this.agentId,
      data: { pid: process.pid, pollIntervalMs: this.opts.pollIntervalMs, mode: 'agent' },
    });
    this.log(
      `[${nowIso()}] runner started for "${agent.id}" (${agent.provider}/${agent.model}) ` +
        `session=${agent.tmuxSession} poll=${this.opts.pollIntervalMs}ms`,
    );

    try {
      do {
        if (this.shouldStop()) break;
        await this.tick();
        if (this.once) break;
        await sleep(this.opts.pollIntervalMs, this.signal);
      } while (!this.shouldStop());
    } finally {
      await this.shutdown();
    }
  }

  private shouldStop(): boolean {
    return this.stopped || this.signal?.aborted === true;
  }

  private async shutdown(): Promise<void> {
    this.stopped = true;
    await this.workspace.bus.writeStatus(this.agentId, 'stopped', { pid: process.pid });
    await this.workspace.events.emit({ type: 'runner.stopped', actor: this.agentId });
    this.log(`[${nowIso()}] runner stopped for "${this.agentId}"`);
  }

  /** One poll cycle: drain whatever is new in the inbox. */
  async tick(): Promise<void> {
    const agent = await this.workspace.agents.get(this.agentId);

    if (!agent.enabled) {
      await this.heartbeat('waiting_input', 'agent is disabled; not accepting work');
      return;
    }

    const { messages, offset } = await this.workspace.bus.readInboxFromCursor(this.agentId);
    if (messages.length === 0) {
      await this.heartbeat('idle');
      return;
    }

    let consumed = 0;
    for (const message of messages) {
      if (this.shouldStop()) break;
      consumed += 1;
      if (this.handled.has(message.id)) continue;
      try {
        await this.handleMessage(agent, message);
      } catch (error) {
        await this.reportFailure(agent, message, errorMessage(error));
      }
    }

    // Only advance the cursor past messages we actually looked at. A partial
    // drain (worker stopped mid-batch) is resumed on the next start.
    if (consumed === messages.length) {
      await this.workspace.bus.writeCursor(this.agentId, offset, messages.at(-1)?.id);
    } else {
      await this.recomputeCursor(messages.slice(0, consumed));
    }
  }

  private async recomputeCursor(processed: readonly Message[]): Promise<void> {
    const last = processed.at(-1);
    if (!last) return;
    // Re-read from the stored cursor and stop at the last processed id, so the
    // offset stays byte-accurate without us tracking line lengths ourselves.
    const mailbox = mailboxPaths(this.workspace.project.rootPath, this.agentId);
    const raw = await fs.readFile(mailbox.inbox, 'utf8');
    const idx = raw.indexOf(`"id":"${last.id}"`);
    if (idx === -1) return;
    const lineEnd = raw.indexOf('\n', idx);
    if (lineEnd === -1) return;
    await this.workspace.bus.writeCursor(
      this.agentId,
      Buffer.byteLength(raw.slice(0, lineEnd + 1), 'utf8'),
      last.id,
    );
  }

  private async handleMessage(agent: Agent, message: Message): Promise<void> {
    await this.workspace.events.emit({
      type: 'message.received',
      actor: this.agentId,
      subject: message.from,
      correlationId: message.correlationId,
      data: { messageId: message.id, messageType: message.type },
    });

    switch (message.type) {
      case 'task':
        await this.executeTask(agent, message);
        return;
      case 'cancel':
        // A cancel that arrives while idle has nothing to interrupt; record it.
        this.log(`[${nowIso()}] cancel for ${message.correlationId} arrived while idle`);
        await this.markCancelled(message.correlationId);
        return;
      case 'question':
      case 'status':
      case 'result':
      case 'error':
      case 'ack':
        this.log(`[${nowIso()}] ${message.type} from ${message.from} (${message.correlationId})`);
        return;
    }
  }

  private async executeTask(agent: Agent, message: Message): Promise<void> {
    const task = await this.workspace.tasks.find(message.correlationId);
    await this.runDispatchPipeline(agent, message, task);
  }

  /**
   * Re-attempts tmux delivery for a task whose notification previously
   * failed (see `deliverTask`), without creating a new task, envelope, or
   * inbox message — the whole point is that a retry reuses what already
   * exists. Used by `agentctl task redeliver`.
   */
  async redeliverTask(correlationId: string): Promise<void> {
    const agent = await this.workspace.agents.get(this.agentId);
    const task = await this.workspace.tasks.get(correlationId);
    if (isTerminal(task.state)) {
      throw new ValidationError(
        `Task ${correlationId} already finished with state "${task.state}"`,
        'Assign a new task instead of redelivering one that already finished.',
      );
    }

    const inbox = await this.workspace.bus.readInbox(this.agentId);
    const message = inbox.find((m) => m.type === 'task' && m.correlationId === correlationId);
    if (!message) {
      throw new NotFoundError(
        `No task message ${correlationId} found in "${this.agentId}"'s inbox`,
        'The task cannot be redelivered without its original message.',
      );
    }

    await this.runDispatchPipeline(agent, message, task, { throwOnNotificationFailure: true });
  }

  /**
   * Builds (or reuses) the envelope, delivers the dispatch line to the
   * agent's tmux pane, and waits for a response. Shared by the poll loop and
   * `redeliverTask` so both paths behave identically.
   *
   * `throwOnNotificationFailure` distinguishes the two callers: the poll loop
   * (`executeTask`) must not throw on a failed notification — that would
   * route through `reportFailure` and mark the task terminally `failed`,
   * defeating the whole point of keeping it retriable. `redeliverTask` is a
   * synchronous, explicit user action, so it throws instead, giving the CLI a
   * non-zero exit and a clear message — the task record itself still stays
   * non-terminal either way.
   */
  private async runDispatchPipeline(
    agent: Agent,
    message: Message,
    task: Task | undefined,
    options: { throwOnNotificationFailure?: boolean } = {},
  ): Promise<void> {
    const correlationId = message.correlationId;
    const provider = getProvider(agent.provider);

    const execution = message.execution ??
      task?.execution ?? {
        provider: agent.provider,
        model: agent.model,
        ...(agent.reasoningEffort === undefined ? {} : { reasoningEffort: agent.reasoningEffort }),
      };

    const mailbox = mailboxPaths(this.workspace.project.rootPath, this.agentId);
    await ensureDir(mailbox.workDir);
    const envelopePath = path.join(mailbox.workDir, `${correlationId}.envelope.md`);
    const responsePath = path.join(mailbox.workDir, `${correlationId}.response.md`);
    // A stale response from a previous attempt would be read as this one's.
    await fs.rm(responsePath, { force: true });

    const context: DispatchContext = {
      agent,
      execution,
      from: message.from,
      correlationId,
      messageId: message.id,
      body: message.body,
      workingDirectory: agent.workingDirectory,
      envelopePath,
      responsePath,
      contextRefs: message.contextRefs ?? task?.contextRefs ?? [],
      contextDir: this.workspace.context.dir,
    };

    // Idempotent: a redelivery after a notification failure must not
    // re-announce a new envelope for work the agent may already be reading.
    if (!(await pathExists(envelopePath))) {
      await fs.writeFile(envelopePath, provider.buildEnvelope(context), 'utf8');
      await this.workspace.events.emit({
        type: 'envelope.created',
        actor: this.agentId,
        subject: message.from,
        correlationId,
        data: { envelopePath },
      });
    }

    await this.workspace.bus.writeStatus(this.agentId, 'busy', {
      correlationId,
      pid: process.pid,
      detail: `dispatching to ${agent.tmuxSession}`,
    });
    if (task)
      task = await this.workspace.tasks.update(correlationId, (t) => ({
        ...t,
        attempts: t.attempts + 1,
      }));

    const delivery = await this.deliverTask(
      agent,
      task,
      correlationId,
      provider.buildDispatchLine(context),
      provider.submitDelayMs,
    );
    // Notification failed: recorded via `notification.failed` and left on the
    // task's `error`/`delivery` fields. The task stays non-terminal so a
    // `task redeliver` reuses the same task and envelope instead of a duplicate.
    if (!delivery) {
      if (options.throwOnNotificationFailure) {
        const latest = task ? await this.workspace.tasks.find(correlationId) : undefined;
        throw new TransportError(
          latest?.error ?? `tmux delivery failed for task ${correlationId}`,
          {
            hint: `The task was left as "${latest?.state ?? 'pending'}", not failed — fix the tmux session and retry: agentctl task redeliver ${correlationId}`,
          },
        );
      }
      return;
    }

    if (task) {
      await this.workspace.tasks.transition(correlationId, 'dispatched');
      await this.workspace.tasks.transition(correlationId, 'in_progress');
    }
    this.log(
      `[${nowIso()}] dispatched ${correlationId} to ${agent.tmuxSession} (pane ${delivery.paneId})`,
    );

    const outcome = await this.awaitResponse(delivery.paneId, correlationId, responsePath);

    if (outcome.kind === 'cancelled') {
      await this.workspace.tmux.sendKeys(delivery.paneId, [...provider.interruptKeys]);
      await this.markCancelled(correlationId);
      await this.publish(agent, message, 'error', 'Task cancelled before a result was produced.', {
        cancelled: true,
      });
      return;
    }

    if (outcome.kind === 'timeout') {
      await this.workspace.tmux.sendKeys(delivery.paneId, [...provider.interruptKeys]);
      if (task) {
        await this.workspace.tasks.transition(correlationId, 'timed_out', {
          error: `No response after ${this.opts.responseTimeoutMs}ms`,
        });
      }
      await this.publish(
        agent,
        message,
        'error',
        `No response captured after ${Math.round(this.opts.responseTimeoutMs / 1000)}s. ` +
          `The session may be waiting for input; inspect it with: tmux attach -t ${agent.tmuxSession}`,
        { timedOut: true },
      );
      return;
    }

    if (task) {
      await this.workspace.tasks.transition(correlationId, 'completed', { result: outcome.text });
    }
    await this.publish(agent, message, 'result', outcome.text, { source: outcome.source });
    this.log(`[${nowIso()}] completed ${correlationId} via ${outcome.source}`);
  }

  /**
   * Resolves a live pane for `agent` and delivers `text` to it via the paste
   * buffer (see `deliverToPane`). On any failure — pane resolution, paste, or
   * submit — the failure is recorded (`notification.failed`, task `error` and
   * `delivery` telemetry, a pane-tail capture) and `undefined` is returned;
   * the caller must not treat that as delivered.
   */
  private async deliverTask(
    agent: Agent,
    task: Task | undefined,
    correlationId: string,
    text: string,
    settleMs: number,
  ): Promise<DeliveryTelemetry | undefined> {
    let pane: ResolvedPane;
    try {
      pane = await resolvePane(this.workspace.tmux, agent.tmuxSession, {
        paneIdHint: agent.tmuxPane?.paneId,
        agentId: agent.id,
      });
    } catch (error) {
      await this.recordNotificationFailure(correlationId, task, errorMessage(error));
      return undefined;
    }

    // Cache the pane so the next dispatch skips straight to the fast path.
    if (agent.tmuxPane?.paneId !== pane.paneId) {
      await this.workspace.agents.recordPane(agent.id, {
        paneId: pane.paneId,
        windowIndex: pane.windowIndex,
        paneIndex: pane.paneIndex,
        resolvedAt: nowIso(),
      });
    }

    try {
      const telemetry = await deliverToPane(this.workspace.tmux, pane, text, {
        settleMs,
        signal: this.signal,
      });
      if (task) {
        await this.workspace.tasks.update(correlationId, (t) => ({ ...t, delivery: telemetry }));
      }
      await this.workspace.events.emit({
        type: 'notification.delivered',
        actor: this.agentId,
        correlationId,
        data: { paneId: telemetry.paneId, resolvedVia: telemetry.resolvedVia },
      });
      return telemetry;
    } catch (error) {
      const partial = error instanceof DeliveryStageError ? error.partial : {};
      const telemetry: DeliveryTelemetry = {
        paneId: pane.paneId,
        resolvedVia: pane.resolvedVia,
        queuedAt: partial.queuedAt ?? nowIso(),
        ...(partial.pastedAt === undefined ? {} : { pastedAt: partial.pastedAt }),
        lastError: errorMessage(error),
        paneTail: await this.capturePaneTail(pane.paneId),
      };
      await this.recordNotificationFailure(correlationId, task, errorMessage(error), telemetry);
      return undefined;
    }
  }

  private async capturePaneTail(paneId: string): Promise<string | undefined> {
    try {
      return await this.workspace.tmux.capturePane(paneId, 60);
    } catch {
      return undefined;
    }
  }

  private async recordNotificationFailure(
    correlationId: string,
    task: Task | undefined,
    detail: string,
    telemetry?: DeliveryTelemetry,
  ): Promise<void> {
    if (task) {
      await this.workspace.tasks.update(correlationId, (t) => ({
        ...t,
        error: detail,
        ...(telemetry ? { delivery: telemetry } : {}),
      }));
    }
    await this.workspace.bus.writeStatus(this.agentId, 'error', {
      correlationId,
      pid: process.pid,
      detail,
    });
    await this.workspace.events.emit({
      type: 'notification.failed',
      actor: this.agentId,
      correlationId,
      data: {
        detail: detail.slice(0, 1000),
        ...(telemetry?.paneId ? { paneId: telemetry.paneId } : {}),
      },
    });
    this.log(`[${nowIso()}] notification failed for ${correlationId}: ${detail}`);
  }

  private async awaitResponse(
    paneId: string,
    correlationId: string,
    responsePath: string,
  ): Promise<
    | { kind: 'result'; text: string; source: 'file' | 'terminal' }
    | { kind: 'timeout' }
    | { kind: 'cancelled' }
  > {
    const deadline = Date.now() + this.opts.responseTimeoutMs;
    let previous: FileSnapshot | undefined;

    while (Date.now() < deadline) {
      if (this.shouldStop()) return { kind: 'cancelled' };
      if (await this.cancelRequested(correlationId)) return { kind: 'cancelled' };

      const current = await snapshotFile(responsePath);
      if (current && sameSnapshot(previous, current)) {
        const text = await readResponseFile(responsePath);
        if (text !== undefined) return { kind: 'result', text, source: 'file' };
      }
      previous = current;

      // Fallback: the client could not write the file but printed the block.
      if (!current) {
        try {
          const capture = await this.workspace.tmux.capturePane(paneId, 400);
          const block = extractSentinelBlock(capture);
          if (block) return { kind: 'result', text: block, source: 'terminal' };
        } catch {
          // Capture is best-effort; the file path remains authoritative.
        }
      }

      await this.heartbeat('busy', `awaiting ${correlationId}`, correlationId);
      await sleep(this.opts.pollIntervalMs, this.signal);
    }

    return { kind: 'timeout' };
  }

  /** Peeks past the cursor for a `cancel` addressed at the running task. */
  private async cancelRequested(correlationId: string): Promise<boolean> {
    const { messages } = await this.workspace.bus.readInboxFromCursor(this.agentId);
    const cancel = messages.find(
      (m) => m.type === 'cancel' && m.correlationId === correlationId && !this.handled.has(m.id),
    );
    if (!cancel) return false;
    this.handled.add(cancel.id);
    return true;
  }

  private async markCancelled(correlationId: string): Promise<Task | undefined> {
    const task = await this.workspace.tasks.find(correlationId);
    if (!task || task.state === 'completed') return task;
    return this.workspace.tasks.transition(correlationId, 'cancelled');
  }

  private async publish(
    agent: Agent,
    original: Message,
    type: 'result' | 'error',
    body: string,
    meta: Record<string, string | number | boolean> = {},
  ): Promise<void> {
    await this.workspace.bus.appendRaw({
      id: newMessageId(),
      correlationId: original.correlationId,
      from: agent.id,
      to: original.from,
      type,
      body,
      createdAt: nowIso(),
      meta: { ...meta, replyTo: original.id },
    });
  }

  private async reportFailure(agent: Agent, message: Message, detail: string): Promise<void> {
    this.log(`[${nowIso()}] ERROR handling ${message.id}: ${detail}`);
    await this.workspace.events.emit({
      type: 'runner.error',
      actor: this.agentId,
      correlationId: message.correlationId,
      data: { detail: detail.slice(0, 1000) },
    });
    await this.workspace.bus.writeStatus(this.agentId, 'error', {
      correlationId: message.correlationId,
      pid: process.pid,
      detail,
    });
    if (await this.workspace.tasks.find(message.correlationId)) {
      await this.workspace.tasks.transition(message.correlationId, 'failed', { error: detail });
    }
    if (message.type === 'task') {
      await this.publish(agent, message, 'error', detail, { failed: true });
    }
  }

  private async heartbeat(
    state: 'idle' | 'busy' | 'waiting_input',
    detail?: string,
    correlationId?: string,
  ): Promise<void> {
    const now = Date.now();
    if (now - this.lastHeartbeatAt < this.opts.heartbeatMs) return;
    this.lastHeartbeatAt = now;
    await this.workspace.bus.writeStatus(this.agentId, state, {
      pid: process.pid,
      ...(detail === undefined ? {} : { detail }),
      ...(correlationId === undefined ? {} : { correlationId }),
    });
    await this.workspace.events.emit({
      type: 'runner.heartbeat',
      actor: this.agentId,
      ...(correlationId === undefined ? {} : { correlationId }),
      data: { state },
    });
  }

  stop(): void {
    this.stopped = true;
  }
}
