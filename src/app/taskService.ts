import fs from 'node:fs/promises';
import path from 'node:path';

import { NotFoundError } from '../core/errors.js';
import { newTaskId } from '../core/ids.js';
import { nowIso } from '../core/time.js';
import { type AgentIndex } from '../domain/hierarchy.js';
import { taskSchema } from '../domain/schemas.js';
import {
  type Agent,
  type ExecutionConfig,
  type Project,
  type Task,
  type TaskState,
} from '../domain/types.js';
import { ensureDir, pathExists, readJsonFile, writeJsonAtomic } from '../infra/fs/atomic.js';
import { withLock } from '../infra/fs/lock.js';
import { projectPaths, taskFile, type ProjectPaths } from '../infra/fs/paths.js';
import { type EventLog } from './eventLog.js';
import { type MessageBus } from './messageBus.js';

export interface AssignTaskInput {
  from: string;
  to: string;
  body: string;
  contextRefs?: readonly string[];
  timeoutMs?: number;
  /** Per-task overrides, validated by the caller against the provider adapter. */
  execution?: Partial<ExecutionConfig>;
}

/** The configuration snapshot recorded on a task — never re-read afterwards. */
export function executionConfigFor(
  agent: Agent,
  override?: Partial<ExecutionConfig>,
): ExecutionConfig {
  const model = override?.model ?? agent.model;
  const reasoningEffort =
    override && 'reasoningEffort' in override ? override.reasoningEffort : agent.reasoningEffort;
  return {
    provider: agent.provider,
    model,
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
  };
}

export class TaskService {
  private readonly paths: ProjectPaths;

  constructor(
    private readonly project: Project,
    private readonly bus: MessageBus,
    private readonly events: EventLog,
  ) {
    this.paths = projectPaths(project.rootPath);
  }

  /**
   * Creates a task record and delivers the matching `task` message. The task
   * carries the execution config snapshot, so a later `agent configure` cannot
   * retroactively change how this unit of work was executed (§10).
   */
  async assign(
    index: AgentIndex,
    target: Agent,
    input: AssignTaskInput,
  ): Promise<{ task: Task; messageId: string }> {
    const execution = executionConfigFor(target, input.execution);
    const id = newTaskId();
    const createdAt = nowIso();

    const task: Task = {
      id,
      projectId: this.project.id,
      from: input.from,
      to: input.to,
      body: input.body,
      state: 'pending',
      execution,
      ...(input.contextRefs && input.contextRefs.length > 0
        ? { contextRefs: [...input.contextRefs] }
        : {}),
      createdAt,
      updatedAt: createdAt,
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
      attempts: 0,
    };

    await this.write(task);
    await this.events.emit({
      type: 'task.created',
      actor: input.from,
      subject: input.to,
      correlationId: id,
      data: {
        model: execution.model,
        provider: execution.provider,
        ...(execution.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: execution.reasoningEffort }),
      },
    });

    const message = await this.bus.send(index, {
      from: input.from,
      to: input.to,
      type: 'task',
      body: input.body,
      correlationId: id,
      ...(task.contextRefs ? { contextRefs: task.contextRefs } : {}),
      execution,
    });

    return { task, messageId: message.id };
  }

  async get(id: string): Promise<Task> {
    const file = taskFile(this.project.rootPath, id);
    if (!(await pathExists(file))) {
      throw new NotFoundError(
        `Task "${id}" not found in project "${this.project.name}"`,
        'Correlation ids are printed by `agentctl task assign` and appear in `agentctl events`.',
      );
    }
    return readJsonFile(file, taskSchema);
  }

  async find(id: string): Promise<Task | undefined> {
    const file = taskFile(this.project.rootPath, id);
    if (!(await pathExists(file))) return undefined;
    return readJsonFile(file, taskSchema);
  }

  async list(): Promise<Task[]> {
    if (!(await pathExists(this.paths.tasksDir))) return [];
    const files = (await fs.readdir(this.paths.tasksDir)).filter((f) => f.endsWith('.json'));
    const tasks: Task[] = [];
    for (const file of files) {
      tasks.push(await readJsonFile(path.join(this.paths.tasksDir, file), taskSchema));
    }
    return tasks.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /** Serialised read-modify-write, so runner and CLI cannot clobber each other. */
  async update(id: string, mutate: (task: Task) => Task): Promise<Task> {
    return withLock(this.paths.locksDir, `task-${id}`, async () => {
      const current = await this.get(id);
      const next = { ...mutate(current), updatedAt: nowIso() };
      await this.write(next);
      return next;
    });
  }

  async transition(
    id: string,
    state: TaskState,
    patch: Partial<Pick<Task, 'result' | 'error' | 'attempts'>> = {},
  ): Promise<Task> {
    const task = await this.update(id, (current) => ({
      ...current,
      ...patch,
      state,
      ...(state === 'dispatched' && current.dispatchedAt === undefined
        ? { dispatchedAt: nowIso() }
        : {}),
      ...(isTerminal(state) ? { completedAt: nowIso() } : {}),
    }));

    const eventType =
      state === 'completed'
        ? 'task.completed'
        : state === 'failed'
          ? 'task.failed'
          : state === 'cancelled'
            ? 'task.cancelled'
            : state === 'timed_out'
              ? 'task.timed_out'
              : state === 'dispatched'
                ? 'task.dispatched'
                : 'task.progress';

    await this.events.emit({
      type: eventType,
      actor: task.to,
      subject: task.from,
      correlationId: task.id,
      data: {
        state,
        ...(patch.error === undefined ? {} : { error: patch.error.slice(0, 500) }),
        ...(patch.result === undefined ? {} : { resultBytes: patch.result.length }),
      },
    });

    return task;
  }

  private async write(task: Task): Promise<void> {
    await ensureDir(this.paths.tasksDir);
    await writeJsonAtomic(taskFile(this.project.rootPath, task.id), taskSchema.parse(task));
  }
}

export function isTerminal(state: TaskState): boolean {
  return (
    state === 'completed' || state === 'failed' || state === 'cancelled' || state === 'timed_out'
  );
}
