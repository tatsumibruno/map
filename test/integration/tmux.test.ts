import fs from 'node:fs/promises';
import path from 'node:path';

import { execa } from 'execa';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Workspace } from '../../src/app/workspace.js';
import { ProjectStore } from '../../src/app/projectStore.js';
import { resolvePane } from '../../src/infra/tmux/paneResolution.js';
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

  it('discovers the pane id via list-panes, matching the shape of the reported bug', async () => {
    const panes = await tmux.listPanes();
    const mine = panes.find((p) => p.sessionName === SESSION);
    expect(mine).toBeDefined();
    expect(mine?.paneId).toMatch(/^%\d+$/);
    expect(mine?.windowIndex).toBe(0);
    expect(mine?.paneIndex).toBe(0);
    expect(mine?.dead).toBe(false);
  });

  it('fails to target a bare "=session" but succeeds with a qualified target or the pane id', async () => {
    // This is the exact defect this transport was rewritten around: `=name`
    // resolves for has-session / target-session but not as a target-pane.
    expect(await tmux.paneInfo(`=${SESSION}`)).toBeUndefined();

    const qualified = await tmux.paneInfo(`=${SESSION}:0.0`);
    expect(qualified?.sessionName).toBe(SESSION);

    const byId = await tmux.paneInfo(qualified?.paneId ?? '');
    expect(byId?.paneId).toBe(qualified?.paneId);
  });

  it('delivers a long, multi-line, special-character message via the paste buffer and confirms submission', async () => {
    const marker = path.join(root, 'paste-marker.txt');
    const pane = await tmux.paneInfo(`=${SESSION}:0.0`);
    if (!pane) throw new Error('pane did not resolve');

    const text = [
      `printf '%s' 'line one "quoted" $var `,
      'backtick` and a tab\t end' + `' > ${marker}`,
    ].join('');
    await tmux.setBuffer(text);
    await tmux.pasteBuffer(pane.paneId, { delete: true });
    // Nothing runs until Enter is sent — confirms paste alone doesn't submit.
    await new Promise((resolve) => setTimeout(resolve, 300));
    await expect(fs.stat(marker)).rejects.toThrow();

    await tmux.sendKeys(pane.paneId, ['C-m']);
    await waitForFile(marker);
    expect(await fs.readFile(marker, 'utf8')).toContain('line one "quoted"');
  });

  it('drives a full task through a real session, resolving and caching a pane id', async () => {
    const workspace = await Workspace.load(root, tmux);
    await workspace.agents.register({
      id: 'shellbot',
      role: 'coordinator',
      provider: 'codex',
      model: 'gpt-5-codex',
      tmuxSession: SESSION,
    });

    // `agent register` resolves a pane best-effort; confirm it actually did.
    const registered = await workspace.agents.get('shellbot');
    expect(registered.tmuxPane?.paneId).toMatch(/^%\d+$/);

    const { task } = await workspace.tasks.assign(
      await workspace.agents.index(),
      await workspace.agents.get('shellbot'),
      { from: 'shellbot', to: 'shellbot', body: 'echo a response' },
    );

    // Stand in for the AI client: a shell one-liner that writes the response
    // file the envelope asks for.
    const envelopePath = path.join(
      root,
      '.agentctl/mailboxes/shellbot/work',
      `${task.id}.envelope.md`,
    );
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
    // The envelope file is written before any tmux call, so waiting on it
    // (rather than polling capture-pane, which can see the pasted text before
    // it is actually submitted with C-m) avoids racing the settle delay.
    await waitForFile(envelopePath);
    await new Promise((resolve) => setTimeout(resolve, 500));
    await tmux.sendText(SESSION, `printf 'integration answer' > ${responsePath}`);
    await dispatched;

    const finished = await workspace.tasks.get(task.id);
    expect(finished.state).toBe('completed');
    expect(finished.result).toBe('integration answer');
    expect(finished.delivery?.paneId).toMatch(/^%\d+$/);
    expect(finished.delivery?.submittedAt).toBeDefined();
  });

  it('reports a dead pane as unusable and surfaces available panes in the error', async () => {
    const deadSession = `${SESSION}-dead`;
    await tmux.newSession(deadSession, { cwd: root, command: ['sh'] });
    try {
      const before = await tmux.paneInfo(`=${deadSession}:0.0`);
      expect(before?.dead).toBe(false);

      // Set remain-on-exit from the test driver, not from inside the pane's
      // shell — that shell has no reason to have `tmux` on its PATH. Then let
      // the pane's process exit without tearing down the pane itself, so
      // list-panes reports it as dead rather than gone.
      const tmuxBin = process.env['AGENTCTL_TMUX_BIN'] ?? 'tmux';
      await execa(tmuxBin, ['set-option', '-t', `=${deadSession}:0.0`, 'remain-on-exit', 'on']);
      await tmux.sendText(deadSession, 'exit');
      let dead = false;
      for (let attempt = 0; attempt < 40 && !dead; attempt += 1) {
        const info = await tmux.paneInfo(`=${deadSession}:0.0`);
        dead = info?.dead === true;
        if (!dead) await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(dead).toBe(true);

      await expect(resolvePane(tmux, deadSession)).rejects.toThrow(/No live tmux pane found/);
    } finally {
      await tmux.killSession(deadSession).catch(() => undefined);
    }
  });

  it('discovers a pane in an independent temporary session and tears it down even on failure', async () => {
    const tempSession = `${SESSION}-temp`;
    await tmux.newSession(tempSession, { cwd: root, command: ['sh'] });
    try {
      const panes = await tmux.listPanes();
      const discovered = panes.find((p) => p.sessionName === tempSession);
      expect(discovered).toBeDefined();
      if (!discovered) throw new Error('pane was not discovered');

      const marker = path.join(root, 'temp-session-marker.txt');
      await tmux.setBuffer(`printf 'submitted' > ${marker}`);
      await tmux.pasteBuffer(discovered.paneId, { delete: true });
      await tmux.sendKeys(discovered.paneId, ['C-m']);
      await waitForFile(marker);
      expect(await fs.readFile(marker, 'utf8')).toBe('submitted');
    } finally {
      // Runs even if an assertion above throws.
      await tmux.killSession(tempSession).catch(() => undefined);
    }
    expect(await tmux.hasSession(tempSession)).toBe(false);
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

describe('integration environment', () => {
  it('reports whether tmux integration tests ran', () => {
    if (!hasTmux) {
      console.warn('tmux is not installed; tmux integration tests were skipped.');
    }
    expect(typeof hasTmux).toBe('boolean');
  });
});
