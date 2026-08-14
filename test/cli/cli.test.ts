import fs from 'node:fs/promises';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildProgram, run } from '../../src/cli/index.js';
import {
  candidates,
  flagValue,
  flagsFor,
  subcommandsFor,
} from '../../src/cli/commands/complete.js';
import { setTmuxClient } from '../../src/cli/context.js';
import { completionScript, installInstructions } from '../../src/cli/completion/scripts.js';
import { FakeTmuxClient, makeTempDir } from '../helpers.js';

let home: string;
let cwd: string;
let stdout: string[];
let stderr: string[];
let tmux: FakeTmuxClient;
const cleanups: string[] = [];

/** Runs the CLI in-process and captures what it printed. */
async function cli(...argv: string[]): Promise<{ code: number; out: string; err: string }> {
  stdout = [];
  stderr = [];
  process.exitCode = undefined;
  const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout.push(String(chunk));
    return true;
  });
  const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr.push(String(chunk));
    return true;
  });
  try {
    const code = await run(['node', 'agentctl', ...argv]);
    return { code, out: stdout.join(''), err: stderr.join('') };
  } finally {
    outSpy.mockRestore();
    errSpy.mockRestore();
    process.exitCode = undefined;
  }
}

beforeEach(async () => {
  home = await makeTempDir('agentctl-home');
  cwd = await makeTempDir('agentctl-cwd');
  cleanups.push(home, cwd);
  process.env['AGENTCTL_HOME'] = home;
  process.env['NO_COLOR'] = '1';
  tmux = new FakeTmuxClient(new Set(['coord', 'research']));
  setTmuxClient(tmux);
  vi.spyOn(process, 'cwd').mockReturnValue(cwd);
});

afterEach(async () => {
  vi.restoreAllMocks();
  setTmuxClient(undefined);
  delete process.env['AGENTCTL_HOME'];
  await Promise.all(cleanups.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('cli end-to-end (fake tmux)', () => {
  it('runs the documented quick start and delivers a task', async () => {
    const projectRoot = path.join(cwd, 'product');

    const init = await cli('project', 'init', 'product', '--path', projectRoot);
    expect(init.code).toBe(0);
    expect(init.out).toContain('Created project product');

    const registerCoordinator = await cli(
      'agent',
      'register',
      'coordinator',
      '--project',
      'product',
      '--role',
      'coordinator',
      '--provider',
      'codex',
      '--model',
      'gpt-5-codex',
      '--reasoning-effort',
      'medium',
      '--tmux',
      'coord',
    );
    expect(registerCoordinator.code).toBe(0);

    const registerResearcher = await cli(
      'agent',
      'register',
      'researcher',
      '--project',
      'product',
      '--role',
      'agent',
      '--provider',
      'claude-code',
      '--model',
      'sonnet',
      '--tmux',
      'research',
      '--parent',
      'coordinator',
    );
    expect(registerResearcher.code).toBe(0);

    const list = await cli('agent', 'list', '--project', 'product');
    expect(list.out).toContain('coordinator');
    expect(list.out).toContain('researcher');

    const assign = await cli(
      '--project',
      'product',
      'task',
      'assign',
      '--from',
      'coordinator',
      '--to',
      'researcher',
      'Research persistence alternatives and recommend one.',
    );
    expect(assign.code).toBe(0);
    const correlationId = /task_[a-z0-9]+/.exec(assign.out)?.[0];
    expect(correlationId).toBeDefined();

    const inbox = await fs.readFile(
      path.join(projectRoot, '.agentctl/mailboxes/researcher/inbox.jsonl'),
      'utf8',
    );
    expect(inbox).toContain('Research persistence alternatives');

    const events = await cli('--project', 'product', 'events');
    expect(events.out).toContain('agent.registered');
    expect(events.out).toContain('task.created');

    const tasks = await cli('--project', 'product', '--json', 'task', 'list');
    const parsed = JSON.parse(tasks.out) as { execution: { model: string } }[];
    expect(parsed[0]?.execution.model).toBe('sonnet');
  });

  it('redelivers a task after tmux delivery fails, without duplicating it', async () => {
    const projectRoot = path.join(cwd, 'product');
    await cli('project', 'init', 'product', '--path', projectRoot);
    await cli(
      'agent',
      'register',
      'coordinator',
      '--project',
      'product',
      '--role',
      'coordinator',
      '--provider',
      'codex',
      '--model',
      'gpt-5-codex',
      '--reasoning-effort',
      'medium',
      '--tmux',
      'coord',
    );
    await cli(
      'agent',
      'register',
      'researcher',
      '--project',
      'product',
      '--role',
      'agent',
      '--provider',
      'claude-code',
      '--model',
      'sonnet',
      '--tmux',
      'research',
      '--parent',
      'coordinator',
    );

    const assign = await cli(
      '--project',
      'product',
      'task',
      'assign',
      '--from',
      'coordinator',
      '--to',
      'researcher',
      'Do the thing.',
    );
    const correlationId = /task_[a-z0-9]+/.exec(assign.out)?.[0];
    expect(correlationId).toBeDefined();
    if (!correlationId) throw new Error('no correlation id');

    // The pane disappears before anything ever gets delivered.
    tmux.removeSession('research');
    const failed = await cli('--project', 'product', 'task', 'redeliver', correlationId);
    expect(failed.code).toBe(5);
    expect(failed.err).toContain('No live tmux pane found');

    const afterFailure = await cli('--project', 'product', '--json', 'task', 'list');
    const tasksAfterFailure = JSON.parse(afterFailure.out) as { id: string; state: string }[];
    expect(tasksAfterFailure).toHaveLength(1);
    expect(tasksAfterFailure[0]?.state).not.toBe('failed');

    // Bring the pane back and redeliver again — same task, no duplicate.
    tmux.addSession('research');
    tmux.onDispatch = async (sent) => {
      const responsePath = /write your final answer to (\S+?)\.?$/.exec(sent.text.trim())?.[1];
      if (responsePath) await fs.writeFile(responsePath, 'redelivered answer', 'utf8');
    };
    const redelivered = await cli('--project', 'product', 'task', 'redeliver', correlationId);
    expect(redelivered.code).toBe(0);

    const finalTasks = JSON.parse(
      (await cli('--project', 'product', '--json', 'task', 'list')).out,
    ) as { id: string; state: string; result?: string }[];
    expect(finalTasks).toHaveLength(1);
    expect(finalTasks[0]?.state).toBe('completed');
    expect(finalTasks[0]?.result).toBe('redelivered answer');
  });

  it('reports a missing tmux session with an actionable message', async () => {
    await cli('project', 'init', 'product', '--path', path.join(cwd, 'product'));
    const result = await cli(
      'agent',
      'register',
      'ghost',
      '--project',
      'product',
      '--role',
      'coordinator',
      '--provider',
      'codex',
      '--model',
      'gpt-5-codex',
      '--tmux',
      'nope',
    );
    expect(result.code).toBe(3);
    expect(result.err).toContain('tmux session "nope" does not exist');
    expect(result.err).toContain('tmux new -s nope');
  });

  it('rejects an unsupported reasoning effort at registration time', async () => {
    await cli('project', 'init', 'product', '--path', path.join(cwd, 'product'));
    const result = await cli(
      'agent',
      'register',
      'researcher',
      '--project',
      'product',
      '--role',
      'coordinator',
      '--provider',
      'claude-code',
      '--model',
      'sonnet',
      '--reasoning-effort',
      'high',
      '--tmux',
      'research',
    );
    expect(result.code).toBe(2);
    expect(result.err).toContain('does not expose a selectable reasoning effort');
  });

  it('tracks the active project and finds it from the working directory', async () => {
    const projectRoot = path.join(cwd, 'product');
    await cli('project', 'init', 'product', '--path', projectRoot);

    const listed = await cli('--json', 'project', 'list');
    const parsed = JSON.parse(listed.out) as { activeProject: string; projects: unknown[] };
    expect(parsed.activeProject).toBe('product');
    expect(parsed.projects).toHaveLength(1);

    vi.spyOn(process, 'cwd').mockReturnValue(projectRoot);
    const context = await cli('--json', 'project', 'context', 'list');
    const entries = JSON.parse(context.out) as { ref: string }[];
    expect(entries.map((e) => e.ref)).toContain(path.join('.agentctl', 'context', 'shared.md'));
  });

  it('allows a project-specific model and then registers with it', async () => {
    const projectRoot = path.join(cwd, 'product');
    await cli('project', 'init', 'product', '--path', projectRoot);

    const allowed = await cli(
      '--project',
      'product',
      'project',
      'model',
      'allow',
      'codex',
      'gpt-6-preview',
    );
    expect(allowed.code).toBe(0);

    const registered = await cli(
      'agent',
      'register',
      'coordinator',
      '--project',
      'product',
      '--role',
      'coordinator',
      '--provider',
      'codex',
      '--model',
      'gpt-6-preview',
      '--tmux',
      'coord',
    );
    expect(registered.code).toBe(0);
  });

  it('copies a context file and refuses sources outside the project root', async () => {
    const projectRoot = path.join(cwd, 'product');
    await cli('project', 'init', 'product', '--path', projectRoot);

    const inside = path.join(projectRoot, 'notes.md');
    await fs.writeFile(inside, '# notes', 'utf8');
    const added = await cli('--project', 'product', 'project', 'context', 'add', inside);
    expect(added.code).toBe(0);
    await expect(
      fs.readFile(path.join(projectRoot, '.agentctl/context/notes.md'), 'utf8'),
    ).resolves.toBe('# notes');

    const outside = path.join(cwd, 'outside.md');
    await fs.writeFile(outside, 'secret-ish', 'utf8');
    const refused = await cli('--project', 'product', 'project', 'context', 'add', outside);
    expect(refused.code).toBe(2);
    expect(refused.err).toContain('outside the project root');
    expect(refused.err).toContain('--allow-outside-root');
  });

  it('lists tmux sessions and marks which are registered', async () => {
    const projectRoot = path.join(cwd, 'product');
    await cli('project', 'init', 'product', '--path', projectRoot);
    await cli(
      'agent',
      'register',
      'coordinator',
      '--project',
      'product',
      '--role',
      'coordinator',
      '--provider',
      'codex',
      '--model',
      'gpt-5-codex',
      '--tmux',
      'coord',
    );
    const listed = await cli('--project', 'product', '--json', 'session', 'list');
    const sessions = JSON.parse(listed.out) as { name: string; agentId: string | null }[];
    expect(sessions.find((s) => s.name === 'coord')?.agentId).toBe('coordinator');
    expect(sessions.find((s) => s.name === 'research')?.agentId).toBeNull();
  });

  it('runs doctor and reports the project state', async () => {
    const projectRoot = path.join(cwd, 'product');
    await cli('project', 'init', 'product', '--path', projectRoot);
    const result = await cli('--project', 'product', '--json', 'doctor');
    const report = JSON.parse(result.out) as {
      ok: boolean;
      checks: { name: string; status: string }[];
    };
    expect(report.checks.find((c) => c.name === 'tmux')?.status).toBe('ok');
    expect(report.checks.find((c) => c.name === 'state-directory')?.status).toBe('ok');
    expect(report.checks.find((c) => c.name === 'agents')?.status).toBe('warn');
    expect(report.ok).toBe(true);
  });

  it('flags a registered agent whose session vanished', async () => {
    const projectRoot = path.join(cwd, 'product');
    await cli('project', 'init', 'product', '--path', projectRoot);
    await cli(
      'agent',
      'register',
      'coordinator',
      '--project',
      'product',
      '--role',
      'coordinator',
      '--provider',
      'codex',
      '--model',
      'gpt-5-codex',
      '--tmux',
      'coord',
    );
    tmux.removeSession('coord');

    const result = await cli('--project', 'product', '--json', 'doctor');
    const report = JSON.parse(result.out) as {
      ok: boolean;
      checks: { name: string; status: string }[];
    };
    expect(report.checks.find((c) => c.name === 'agent:coordinator')?.status).toBe('fail');
    expect(report.ok).toBe(false);
  });

  it('fails with a clear message when no project is selected', async () => {
    const result = await cli('agent', 'list');
    expect(result.code).toBe(3);
    expect(result.err).toContain('No project selected');
  });
});

describe('completion', () => {
  it('generates a script for every supported shell', () => {
    for (const shell of ['bash', 'zsh', 'fish'] as const) {
      const script = completionScript(shell, 'agentctl');
      expect(script.length).toBeGreaterThan(100);
      expect(script).toContain('agentctl');
      expect(script).toContain('__complete');
      expect(installInstructions(shell, 'agentctl')).toContain('agentctl completion');
    }
    expect(completionScript('bash', 'agentctl')).toContain('complete -F _agentctl agentctl');
    expect(completionScript('zsh', 'agentctl')).toContain('#compdef agentctl');
    expect(completionScript('fish', 'agentctl')).toContain('complete -c agentctl');
  });

  it('rejects an unsupported shell', async () => {
    const result = await cli('completion', 'powershell');
    expect(result.code).toBe(2);
    expect(result.err).toContain('Unsupported shell');
  });

  it('reads flag values out of the tokens typed so far', () => {
    expect(flagValue(['agent', 'register', '--provider', 'codex'], '--provider')).toBe('codex');
    expect(flagValue(['--provider=codex'], '--provider')).toBe('codex');
    expect(flagValue(['--provider', '--model'], '--provider')).toBeUndefined();
    expect(flagValue(['agent'], '--provider')).toBeUndefined();
  });

  it('suggests subcommands for the current command path', () => {
    expect(subcommandsFor(['agent'])).toContain('register');
    expect(subcommandsFor(['project', 'context'])).toEqual(['add', 'list']);
    expect(subcommandsFor([])).toContain('doctor');
  });

  it('suggests the flags declared on the current command', () => {
    const flags = flagsFor(buildProgram(), ['agent', 'register']);
    expect(flags).toContain('--provider');
    expect(flags).toContain('--reasoning-effort');
    expect(flags).toContain('--project');
  });

  it('completes providers, roles, models and reasoning efforts', async () => {
    const program = () => buildProgram();
    expect(await candidates('providers', [], program)).toEqual(['codex', 'claude-code']);
    expect(await candidates('roles', [], program)).toEqual(['coordinator', 'agent']);
    expect(await candidates('models', ['--provider', 'codex'], program)).toContain('gpt-5-codex');
    expect(await candidates('models', ['--provider', 'claude-code'], program)).not.toContain(
      'gpt-5-codex',
    );
    expect(
      await candidates('efforts', ['--provider', 'codex', '--model', 'gpt-5-codex'], program),
    ).toEqual(['minimal', 'low', 'medium', 'high']);
    expect(
      await candidates('efforts', ['--provider', 'claude-code', '--model', 'sonnet'], program),
    ).toEqual([]);
  });

  it('completes live tmux sessions, project names and agent names', async () => {
    const projectRoot = path.join(cwd, 'product');
    await cli('project', 'init', 'product', '--path', projectRoot);
    await cli(
      'agent',
      'register',
      'coordinator',
      '--project',
      'product',
      '--role',
      'coordinator',
      '--provider',
      'codex',
      '--model',
      'gpt-5-codex',
      '--tmux',
      'coord',
    );

    const program = () => buildProgram();
    expect(await candidates('sessions', [], program)).toEqual(['coord', 'research']);
    expect(await candidates('projects', [], program)).toEqual(['product']);
    expect(await candidates('agents', ['--project', 'product'], program)).toEqual(['coordinator']);
  });

  it('never throws for an unknown completion kind', async () => {
    expect(await candidates('nonsense', [], () => buildProgram())).toEqual([]);
  });
});
