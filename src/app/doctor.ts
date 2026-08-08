import fs from 'node:fs/promises';
import path from 'node:path';

import { errorMessage } from '../core/errors.js';
import { elapsedMs } from '../core/time.js';
import { agentSchema, messageSchema, agentEventSchema } from '../domain/schemas.js';
import { readJsonlLenient } from '../infra/fs/jsonl.js';
import { pathExists } from '../infra/fs/atomic.js';
import { mailboxPaths } from '../infra/fs/paths.js';
import { createTmuxClient, type TmuxClient } from '../infra/tmux/tmux.js';
import { getProvider } from '../providers/registry.js';
import { GlobalConfigStore } from './globalConfig.js';
import { RunnerSupervisor } from './runnerSupervisor.js';
import { Workspace } from './workspace.js';

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
  hint?: string;
}

export interface DoctorReport {
  checks: CheckResult[];
  ok: boolean;
}

/** Heartbeats older than this suggest a wedged or dead runner. */
const STALE_HEARTBEAT_MS = 120_000;

export async function runDoctor(
  selector: { project?: string | undefined; path?: string | undefined; cwd?: string | undefined },
  tmux: TmuxClient = createTmuxClient(),
): Promise<DoctorReport> {
  const checks: CheckResult[] = [];

  checks.push(await checkNodeVersion());
  checks.push(await checkTmux(tmux));

  let workspace: Workspace | undefined;
  try {
    workspace = await Workspace.resolve(selector, tmux);
    checks.push({
      name: 'project',
      status: 'ok',
      detail: `"${workspace.project.name}" at ${workspace.project.rootPath}`,
    });
  } catch (error) {
    checks.push({
      name: 'project',
      status: 'warn',
      detail: `No project resolved: ${errorMessage(error)}`,
      hint: 'Run `agentctl project init <name>` or pass --project.',
    });
    return finish(checks);
  }

  checks.push(await checkStateDirectory(workspace));
  checks.push(...(await checkAgents(workspace, tmux)));
  checks.push(...(await checkMailboxes(workspace)));
  checks.push(await checkEventLog(workspace));
  checks.push(await checkGlobalConfig(workspace));
  checks.push(await checkStaleLocks(workspace));

  return finish(checks);
}

function finish(checks: CheckResult[]): DoctorReport {
  return { checks, ok: !checks.some((c) => c.status === 'fail') };
}

async function checkNodeVersion(): Promise<CheckResult> {
  const major = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
  if (major >= 18) {
    return { name: 'node', status: 'ok', detail: `Node ${process.versions.node}` };
  }
  return {
    name: 'node',
    status: 'fail',
    detail: `Node ${process.versions.node} is too old`,
    hint: 'agentctl requires Node 18 or newer.',
  };
}

async function checkTmux(tmux: TmuxClient): Promise<CheckResult> {
  if (!(await tmux.isAvailable())) {
    return {
      name: 'tmux',
      status: 'fail',
      detail: 'tmux was not found on PATH',
      hint: 'Install tmux, or set AGENTCTL_TMUX_BIN to its location.',
    };
  }
  const sessions = await tmux.listSessions();
  return {
    name: 'tmux',
    status: 'ok',
    detail: `${await tmux.version()} — ${sessions.length} session(s) running`,
  };
}

async function checkStateDirectory(workspace: Workspace): Promise<CheckResult> {
  const required = [
    workspace.paths.state,
    workspace.paths.agentsDir,
    workspace.paths.mailboxesDir,
    workspace.paths.contextDir,
    workspace.paths.locksDir,
  ];
  const missing: string[] = [];
  for (const dir of required) {
    if (!(await pathExists(dir))) missing.push(path.relative(workspace.paths.root, dir));
  }
  if (missing.length > 0) {
    return {
      name: 'state-directory',
      status: 'fail',
      detail: `Missing: ${missing.join(', ')}`,
      hint: 'Re-run `agentctl project init` in this directory to recreate the layout.',
    };
  }
  try {
    const probe = path.join(workspace.paths.state, `.doctor-${process.pid}`);
    await fs.writeFile(probe, 'ok', 'utf8');
    await fs.rm(probe, { force: true });
  } catch (error) {
    return {
      name: 'state-directory',
      status: 'fail',
      detail: `${workspace.paths.state} is not writable: ${errorMessage(error)}`,
      hint: 'Check ownership and permissions, especially for a mounted Docker volume.',
    };
  }
  return {
    name: 'state-directory',
    status: 'ok',
    detail: `${workspace.paths.state} is present and writable`,
  };
}

async function checkAgents(workspace: Workspace, tmux: TmuxClient): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const files = (await pathExists(workspace.paths.agentsDir))
    ? (await fs.readdir(workspace.paths.agentsDir)).filter((f) => f.endsWith('.json'))
    : [];

  if (files.length === 0) {
    return [
      {
        name: 'agents',
        status: 'warn',
        detail: 'No agents registered',
        hint: 'Register one with `agentctl agent register <name> ...`.',
      },
    ];
  }

  const tmuxUp = await tmux.isAvailable();
  const sessions = tmuxUp
    ? new Set((await tmux.listSessions()).map((s) => s.name))
    : new Set<string>();

  for (const file of files) {
    const full = path.join(workspace.paths.agentsDir, file);
    let raw: unknown;
    try {
      raw = JSON.parse(await fs.readFile(full, 'utf8'));
    } catch (error) {
      results.push({
        name: `agent:${file}`,
        status: 'fail',
        detail: `Malformed JSON: ${errorMessage(error)}`,
      });
      continue;
    }
    const parsed = agentSchema.safeParse(raw);
    if (!parsed.success) {
      results.push({
        name: `agent:${file}`,
        status: 'fail',
        detail: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      });
      continue;
    }
    const agent = parsed.data;

    try {
      getProvider(agent.provider).validateExecutionConfig(
        {
          model: agent.model,
          ...(agent.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: agent.reasoningEffort }),
        },
        workspace.project.providerModelOverrides?.[agent.provider]
          ? { extraModels: workspace.project.providerModelOverrides[agent.provider] as string[] }
          : {},
      );
    } catch (error) {
      results.push({
        name: `agent:${agent.id}`,
        status: 'warn',
        detail: `Configuration no longer validates: ${errorMessage(error)}`,
        hint: `Fix it with: agentctl agent configure ${agent.id} --model <model>`,
      });
      continue;
    }

    if (!tmuxUp) {
      results.push({
        name: `agent:${agent.id}`,
        status: 'warn',
        detail: `Cannot verify session "${agent.tmuxSession}" because tmux is unavailable`,
      });
      continue;
    }

    if (!sessions.has(agent.tmuxSession)) {
      results.push({
        name: `agent:${agent.id}`,
        status: agent.enabled ? 'fail' : 'warn',
        detail: `tmux session "${agent.tmuxSession}" is not running`,
        hint: `Recreate and re-authenticate it: tmux new -s ${agent.tmuxSession} then run \`${getProvider(agent.provider).expectedCommand}\`.`,
      });
      continue;
    }

    const supervisor = new RunnerSupervisor(workspace);
    const runner = await supervisor.status(agent.id);
    const runnerDetail = runner.record
      ? runner.alive
        ? `runner pid ${runner.record.pid} alive`
        : `runner pid ${runner.record.pid} is recorded but not running`
      : 'no runner registered';

    results.push({
      name: `agent:${agent.id}`,
      status: runner.record && !runner.alive ? 'warn' : 'ok',
      detail: `${agent.provider}/${agent.model} on "${agent.tmuxSession}" — ${runnerDetail}`,
      ...(runner.record && !runner.alive
        ? { hint: `Restart it with: agentctl runner start ${agent.id}` }
        : {}),
    });
  }

  return results;
}

async function checkMailboxes(workspace: Workspace): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const agents = await workspace.agents.list();

  for (const agent of agents) {
    const mailbox = mailboxPaths(workspace.project.rootPath, agent.id);
    const problems: string[] = [];

    for (const [label, file] of [
      ['inbox', mailbox.inbox],
      ['outbox', mailbox.outbox],
    ] as const) {
      const { invalidLines } = await readJsonlLenient(file, messageSchema);
      if (invalidLines.length > 0) {
        problems.push(
          `${label} has ${invalidLines.length} malformed line(s): ${invalidLines.slice(0, 5).join(', ')}`,
        );
      }
    }

    const status = await workspace.bus.readStatus(agent.id);
    if (status && status.runnerState !== 'stopped') {
      const age = elapsedMs(status.lastHeartbeatAt);
      if (age > STALE_HEARTBEAT_MS) {
        problems.push(
          `heartbeat is ${Math.round(age / 1000)}s old while state is "${status.runnerState}"`,
        );
      }
    }

    results.push(
      problems.length === 0
        ? { name: `mailbox:${agent.id}`, status: 'ok', detail: 'inbox/outbox parse cleanly' }
        : {
            name: `mailbox:${agent.id}`,
            status: 'warn',
            detail: problems.join('; '),
            hint: 'Inspect the files under .agentctl/mailboxes; malformed lines are skipped, not repaired.',
          },
    );
  }

  return results;
}

async function checkEventLog(workspace: Workspace): Promise<CheckResult> {
  const { entries, invalidLines } = await readJsonlLenient(
    workspace.paths.eventsFile,
    agentEventSchema,
  );
  if (invalidLines.length > 0) {
    return {
      name: 'events',
      status: 'warn',
      detail: `${entries.length} valid event(s), ${invalidLines.length} malformed line(s)`,
      hint: `First bad line: ${invalidLines[0] ?? '?'} in ${workspace.paths.eventsFile}`,
    };
  }
  return { name: 'events', status: 'ok', detail: `${entries.length} event(s) recorded` };
}

async function checkGlobalConfig(workspace: Workspace): Promise<CheckResult> {
  const config = new GlobalConfigStore();
  const projects = await config.listProjects();
  const registered = projects.find((p) => p.rootPath === workspace.project.rootPath);
  if (!registered) {
    return {
      name: 'global-config',
      status: 'warn',
      detail: `This project is not in the user-level registry`,
      hint: `Add it with: agentctl project use ${workspace.project.name} --path ${workspace.project.rootPath}`,
    };
  }
  return {
    name: 'global-config',
    status: 'ok',
    detail: `${projects.length} project(s) registered; active: ${(await config.activeProject()) ?? 'none'}`,
  };
}

async function checkStaleLocks(workspace: Workspace): Promise<CheckResult> {
  if (!(await pathExists(workspace.paths.locksDir))) {
    return { name: 'locks', status: 'ok', detail: 'no lock directory yet' };
  }
  const entries = (await fs.readdir(workspace.paths.locksDir)).filter((e) => e.endsWith('.lock'));
  const stale: string[] = [];
  for (const entry of entries) {
    const stat = await fs.stat(path.join(workspace.paths.locksDir, entry));
    if (Date.now() - stat.mtimeMs > 60_000) stale.push(entry);
  }
  if (stale.length > 0) {
    return {
      name: 'locks',
      status: 'warn',
      detail: `${stale.length} stale lock(s): ${stale.join(', ')}`,
      hint: `Remove them if no agentctl process is running: rm -rf ${workspace.paths.locksDir}/*.lock`,
    };
  }
  return { name: 'locks', status: 'ok', detail: `${entries.length} lock(s) held` };
}
