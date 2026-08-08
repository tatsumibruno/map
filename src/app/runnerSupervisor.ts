import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ConflictError, NotFoundError } from '../core/errors.js';
import { nowIso, sleep } from '../core/time.js';
import { runnerRecordSchema } from '../domain/schemas.js';
import { type RunnerRecord } from '../domain/types.js';
import {
  ensureDir,
  pathExists,
  readJsonFileIfExists,
  writeJsonAtomic,
} from '../infra/fs/atomic.js';
import { projectPaths, runnerFile, runnerLogFile, type ProjectPaths } from '../infra/fs/paths.js';
import { type Workspace } from './workspace.js';

/**
 * Resolves the CLI entry point to re-exec for a detached runner. Works both
 * from `dist/` and from a `tsx`/vitest run against `src/`.
 */
export function resolveCliEntry(): string {
  const override = process.env['AGENTCTL_CLI_ENTRY'];
  if (override && override.trim() !== '') return path.resolve(override);

  const here = path.dirname(fileURLToPath(import.meta.url));
  // When running from `src/` (tests, tsx) the compiled entry point is the only
  // thing plain `node` can execute, so reach into `dist/` instead.
  const fromSource = here.split(path.sep).includes('src');
  return fromSource
    ? path.resolve(here, '..', '..', 'dist', 'bin', 'agentctl.js')
    : path.resolve(here, '..', 'bin', 'agentctl.js');
}

export interface StartRunnerOptions {
  pollIntervalMs?: number;
  responseTimeoutMs?: number;
  /** Fail instead of replacing a runner that is already alive. */
  force?: boolean;
}

/**
 * Supervises runner processes.
 *
 * Note on topology: the registered tmux session is owned by the interactive AI
 * client, so the runner is a *sidecar* process rather than a command typed into
 * that session. It drives the session through `tmux send-keys` and never needs
 * to share its terminal.
 */
export class RunnerSupervisor {
  private readonly paths: ProjectPaths;

  constructor(private readonly workspace: Workspace) {
    this.paths = projectPaths(workspace.project.rootPath);
  }

  async read(agentId: string): Promise<RunnerRecord | undefined> {
    return readJsonFileIfExists(
      runnerFile(this.workspace.project.rootPath, agentId),
      runnerRecordSchema,
    );
  }

  static isAlive(pid: number): boolean {
    try {
      // Signal 0 performs the permission/existence check without delivering.
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
  }

  async status(agentId: string): Promise<{ record?: RunnerRecord; alive: boolean }> {
    const record = await this.read(agentId);
    if (!record) return { alive: false };
    return { record, alive: RunnerSupervisor.isAlive(record.pid) };
  }

  async start(agentId: string, options: StartRunnerOptions = {}): Promise<RunnerRecord> {
    const agent = await this.workspace.agents.get(agentId);
    const existing = await this.status(agentId);
    if (existing.alive && existing.record) {
      if (options.force !== true) {
        throw new ConflictError(
          `A runner for "${agentId}" is already running (pid ${existing.record.pid})`,
          `Stop it with: agentctl runner stop ${agentId}`,
        );
      }
      await this.stop(agentId);
    }

    if (!(await this.workspace.tmux.hasSession(agent.tmuxSession))) {
      throw new NotFoundError(
        `tmux session "${agent.tmuxSession}" does not exist`,
        `Start it and sign in before running the agent: tmux new -s ${agent.tmuxSession}`,
      );
    }

    await ensureDir(this.paths.runnersDir);
    await ensureDir(this.paths.logsDir);
    const logPath = runnerLogFile(this.workspace.project.rootPath, agentId);
    const logFd = await fs.open(logPath, 'a');

    const pollIntervalMs = options.pollIntervalMs ?? 1_500;
    const args = [
      resolveCliEntry(),
      'agent-worker',
      'start',
      agentId,
      '--path',
      this.workspace.project.rootPath,
      '--poll-interval',
      String(pollIntervalMs),
    ];
    if (options.responseTimeoutMs !== undefined) {
      args.push('--response-timeout', String(options.responseTimeoutMs));
    }

    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: ['ignore', logFd.fd, logFd.fd],
      cwd: this.workspace.project.rootPath,
      env: { ...process.env, AGENTCTL_RUNNER: '1' },
    });
    child.unref();
    await logFd.close();

    if (child.pid === undefined) {
      throw new ConflictError(`Failed to start a runner process for "${agentId}"`);
    }

    const record: RunnerRecord = {
      agentId,
      pid: child.pid,
      startedAt: nowIso(),
      logPath,
      pollIntervalMs,
      host: 'process',
    };
    await writeJsonAtomic(runnerFile(this.workspace.project.rootPath, agentId), record);
    return record;
  }

  async stop(agentId: string, options: { timeoutMs?: number } = {}): Promise<boolean> {
    const record = await this.read(agentId);
    if (!record) return false;

    const timeoutMs = options.timeoutMs ?? 5_000;
    if (RunnerSupervisor.isAlive(record.pid)) {
      try {
        process.kill(record.pid, 'SIGTERM');
      } catch {
        // Already gone between the check and the signal.
      }
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline && RunnerSupervisor.isAlive(record.pid)) {
        await sleep(100);
      }
      if (RunnerSupervisor.isAlive(record.pid)) {
        try {
          process.kill(record.pid, 'SIGKILL');
        } catch {
          // Nothing left to kill.
        }
      }
    }

    await fs.rm(runnerFile(this.workspace.project.rootPath, agentId), { force: true });
    await this.workspace.bus.writeStatus(agentId, 'stopped');
    await this.workspace.events.emit({
      type: 'runner.stopped',
      actor: agentId,
      data: { pid: record.pid },
    });
    return true;
  }

  async listRecords(): Promise<RunnerRecord[]> {
    if (!(await pathExists(this.paths.runnersDir))) return [];
    const files = (await fs.readdir(this.paths.runnersDir)).filter((f) => f.endsWith('.json'));
    const records: RunnerRecord[] = [];
    for (const file of files) {
      const record = await readJsonFileIfExists(
        path.join(this.paths.runnersDir, file),
        runnerRecordSchema,
      );
      if (record) records.push(record);
    }
    return records;
  }
}
