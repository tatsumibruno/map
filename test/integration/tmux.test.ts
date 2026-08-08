import fs from 'node:fs/promises';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Workspace } from '../../src/app/workspace.js';
import { ProjectStore } from '../../src/app/projectStore.js';
import { AgentWorker } from '../../src/runner/agentWorker.js';
import { ExecaTmuxClient } from '../../src/infra/tmux/tmux.js';
import { makeTempDir, tmuxAvailable } from '../helpers.js';

const hasTmux = await tmuxAvailable();
const suffix = `${process.pid}`;
const SESSION = `agentctl-it-${suffix}`;

/**
 * These exercise the real tmux binary. They are skipped automatically where
 * tmux is not installed (CI images without it, Windows, minimal containers).
 */
describe.skipIf(!hasTmux)('tmux transport integration', () => {
  const tmux = new ExecaTmuxClient();
  let root: string;
  let base: string;

  beforeAll(async () => {
    base = await makeTempDir('agentctl-it');
    root = path.join(base, 'product');
    await ProjectStore.init({ name: 'product', rootPath: root });
    // A plain shell is enough: no AI client, no credentials, no login.
    await tmux.newSession(SESSION, { cwd: root, command: ['sh'] });
  });

  afterAll(async () => {
    await tmux.killSession(SESSION).catch(() => undefined);
    await fs.rm(base, { recursive: true, force: true });
  });

  it('sees the session it just created', async () => {
    expect(await tmux.hasSession(SESSION)).toBe(true);
    expect((await tmux.listSessions()).map((s) => s.name)).toContain(SESSION);
    expect(await tmux.version()).toMatch(/tmux/);
  });

  it('reports a session that does not exist', async () => {
    expect(await tmux.hasSession(`${SESSION}-nope`)).toBe(false);
  });

  it('types literal text without the shell interpreting it', async () => {
    const marker = path.join(root, 'literal.txt');
    // The single quotes and `$` must survive verbatim through send-keys -l.
    await tmux.sendText(SESSION, `printf '%s' 'a$b;c' > ${marker}`);
    await waitForFile(marker);
    expect(await fs.readFile(marker, 'utf8')).toBe('a$b;c');
  });

  it('captures pane output', async () => {
    await tmux.sendText(SESSION, 'echo agentctl-capture-probe');
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const capture = await tmux.capturePane(SESSION, 50);
      if (capture.includes('agentctl-capture-probe')) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('capture-pane never showed the probe output');
  });

  it('rejects a session name that could be injected into a command', async () => {
    await expect(tmux.hasSession('evil; rm -rf /')).rejects.toThrow(/Invalid tmux session name/);
  });

  it('drives a full task through a real session', async () => {
    const workspace = await Workspace.load(root, tmux);
    await workspace.agents.register({
      id: 'shellbot',
      role: 'coordinator',
      provider: 'codex',
      model: 'gpt-5-codex',
      tmuxSession: SESSION,
    });

    const { task } = await workspace.tasks.assign(
      await workspace.agents.index(),
      await workspace.agents.get('shellbot'),
      { from: 'shellbot', to: 'shellbot', body: 'echo a response' },
    );

    // Stand in for the AI client: a shell one-liner that writes the response
    // file the envelope asks for.
    const responsePath = path.join(
      root,
      '.agentctl/mailboxes/shellbot/work',
      `${task.id}.response.md`,
    );
    const worker = new AgentWorker(workspace, 'shellbot', {
      pollIntervalMs: 200,
      responseTimeoutMs: 20_000,
      once: true,
      logger: () => {},
    });

    const dispatched = worker.run();
    await waitForDispatch(tmux, SESSION, task.id);
    await tmux.sendText(SESSION, `printf 'integration answer' > ${responsePath}`);
    await dispatched;

    const finished = await workspace.tasks.get(task.id);
    expect(finished.state).toBe('completed');
    expect(finished.result).toBe('integration answer');
  });
});

async function waitForFile(file: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fs.stat(file);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`${file} never appeared`);
}

async function waitForDispatch(
  tmux: ExecaTmuxClient,
  session: string,
  correlationId: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const capture = await tmux.capturePane(session, 100);
    if (capture.includes(correlationId)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('the dispatch line never reached the session');
}

describe('integration environment', () => {
  it('reports whether tmux integration tests ran', () => {
    if (!hasTmux) {
      console.warn('tmux is not installed; tmux integration tests were skipped.');
    }
    expect(typeof hasTmux).toBe('boolean');
  });
});
