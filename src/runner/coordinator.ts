import { errorMessage } from '../core/errors.js';
import { nowIso, sleep } from '../core/time.js';
import { childrenOf, descendantsOf } from '../domain/hierarchy.js';
import { type Message } from '../domain/types.js';
import { isTerminal } from '../app/taskService.js';
import { RunnerSupervisor } from '../app/runnerSupervisor.js';
import { type Workspace } from '../app/workspace.js';

export interface CoordinatorOptions {
  pollIntervalMs?: number;
  /** Start (and restart) runners for child agents that have none. */
  superviseChildren?: boolean;
  /** Mark tasks that exceeded their timeout as timed out. */
  enforceTimeouts?: boolean;
  once?: boolean;
  logger?: (line: string) => void;
  signal?: AbortSignal;
}

/**
 * The `coordinator` execution mode. It consolidates results from children and
 * keeps their runners alive — but it never touches a child's terminal: it only
 * reads the shared state directory and writes to mailboxes.
 */
export class CoordinatorProcess {
  private readonly pollIntervalMs: number;
  private readonly superviseChildren: boolean;
  private readonly enforceTimeouts: boolean;
  private readonly once: boolean;
  private readonly log: (line: string) => void;
  private readonly signal: AbortSignal | undefined;
  private readonly supervisor: RunnerSupervisor;
  private readonly cursors = new Map<string, number>();
  private stopped = false;

  constructor(
    private readonly workspace: Workspace,
    options: CoordinatorOptions = {},
  ) {
    this.pollIntervalMs = options.pollIntervalMs ?? 2_000;
    this.superviseChildren = options.superviseChildren ?? false;
    this.enforceTimeouts = options.enforceTimeouts ?? true;
    this.once = options.once ?? false;
    this.log = options.logger ?? ((line) => console.log(line));
    this.signal = options.signal;
    this.supervisor = new RunnerSupervisor(workspace);
  }

  async run(): Promise<void> {
    this.log(`[${nowIso()}] coordinator started for project "${this.workspace.project.name}"`);
    await this.workspace.events.emit({
      type: 'runner.started',
      actor: 'coordinator',
      data: { pid: process.pid, mode: 'coordinator', pollIntervalMs: this.pollIntervalMs },
    });

    try {
      do {
        if (this.shouldStop()) break;
        await this.tick();
        if (this.once) break;
        await sleep(this.pollIntervalMs, this.signal);
      } while (!this.shouldStop());
    } finally {
      await this.workspace.events.emit({ type: 'runner.stopped', actor: 'coordinator' });
      this.log(`[${nowIso()}] coordinator stopped`);
    }
  }

  private shouldStop(): boolean {
    return this.stopped || this.signal?.aborted === true;
  }

  async tick(): Promise<void> {
    const agents = await this.workspace.agents.list();
    const coordinators = agents.filter((a) => a.role === 'coordinator');

    for (const coordinator of coordinators) {
      const inbox = await this.workspace.bus.readInbox(coordinator.id);
      const seen = this.cursors.get(coordinator.id) ?? 0;
      const fresh = inbox.slice(seen);
      this.cursors.set(coordinator.id, inbox.length);
      for (const message of fresh) {
        await this.consolidate(coordinator.id, message);
      }
    }

    if (this.enforceTimeouts) await this.expireTimedOutTasks();

    if (this.superviseChildren) {
      for (const coordinator of coordinators) {
        for (const child of childrenOf(agents, coordinator.id)) {
          if (!child.enabled) continue;
          const status = await this.supervisor.status(child.id);
          if (status.alive) continue;
          try {
            const record = await this.supervisor.start(child.id, { force: true });
            this.log(`[${nowIso()}] started runner for "${child.id}" (pid ${record.pid})`);
          } catch (error) {
            this.log(`[${nowIso()}] cannot start runner for "${child.id}": ${errorMessage(error)}`);
          }
        }
      }
    }
  }

  /** Records a child's reply against its task and logs it for the operator. */
  private async consolidate(coordinatorId: string, message: Message): Promise<void> {
    if (message.type !== 'result' && message.type !== 'error') return;

    const task = await this.workspace.tasks.find(message.correlationId);
    if (task && !isTerminal(task.state)) {
      await this.workspace.tasks.transition(
        task.id,
        message.type === 'result' ? 'completed' : 'failed',
        message.type === 'result' ? { result: message.body } : { error: message.body },
      );
    }

    const preview = message.body.replace(/\s+/g, ' ').slice(0, 160);
    this.log(
      `[${nowIso()}] ${coordinatorId} <- ${message.from} ${message.type} ` +
        `(${message.correlationId}): ${preview}${message.body.length > 160 ? '…' : ''}`,
    );
  }

  private async expireTimedOutTasks(): Promise<void> {
    const now = Date.now();
    for (const task of await this.workspace.tasks.list()) {
      if (task.timeoutMs === undefined || isTerminal(task.state)) continue;
      const startedAt = new Date(task.dispatchedAt ?? task.createdAt).getTime();
      if (now - startedAt < task.timeoutMs) continue;
      await this.workspace.tasks.transition(task.id, 'timed_out', {
        error: `Exceeded the configured timeout of ${task.timeoutMs}ms`,
      });
      this.log(`[${nowIso()}] task ${task.id} timed out`);
    }
  }

  /** Agents the given coordinator is responsible for, at any depth. */
  async subtree(coordinatorId: string) {
    return descendantsOf(await this.workspace.agents.list(), coordinatorId);
  }

  stop(): void {
    this.stopped = true;
  }
}
