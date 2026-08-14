import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { execa } from 'execa';

import { ProjectStore } from '../src/app/projectStore.js';
import { Workspace } from '../src/app/workspace.js';
import {
  type TmuxClient,
  type TmuxPaneInfo,
  type TmuxSessionInfo,
} from '../src/infra/tmux/tmux.js';

export interface SentText {
  /** The target the text was delivered to — a pane id once dispatch resolves one. */
  session: string;
  text: string;
  submit: boolean;
}

export interface FakePane {
  paneId: string;
  sessionName: string;
  windowIndex: number;
  paneIndex: number;
  windowName?: string;
  dead: boolean;
}

/**
 * In-memory tmux stand-in. `onDispatch` lets a test simulate the AI client
 * reacting to the prompt it was sent (e.g. writing the response file).
 *
 * Pane targeting mirrors the real tmux quirk this whole transport was built
 * around: a bare `=session` target (no `:window.pane`) resolves for
 * `has-session` but not for a pane-targeted command, so `paneInfo('=session')`
 * returns `undefined` just like the real binary does. Use `=session:0.0` or a
 * `%id` to get a hit.
 */
export class FakeTmuxClient implements TmuxClient {
  readonly sentText: SentText[] = [];
  readonly sentKeys: { session: string; keys: string[] }[] = [];
  readonly buffers: string[] = [];
  readonly pastes: { target: string; deleted: boolean }[] = [];
  paneContents = new Map<string, string>();
  onDispatch?: (sent: SentText) => void | Promise<void>;
  available = true;

  private readonly sessions: Set<string>;
  private readonly panes = new Map<string, FakePane>();
  private paneSeq = 0;

  constructor(sessions: Iterable<string> = []) {
    this.sessions = new Set();
    for (const name of sessions) this.addSession(name);
  }

  /** Registers a session and, if it has no pane yet, creates a default one at 0.0. */
  addSession(name: string): string {
    this.sessions.add(name);
    const existing = [...this.panes.values()].find((p) => p.sessionName === name);
    if (existing) return existing.paneId;
    return this.addPane({ sessionName: name });
  }

  /** Adds (or replaces) a pane. Returns its generated pane id unless one is supplied. */
  addPane(pane: Partial<FakePane> & { sessionName: string }): string {
    const paneId = pane.paneId ?? `%${this.paneSeq++}`;
    this.panes.set(paneId, {
      paneId,
      sessionName: pane.sessionName,
      windowIndex: pane.windowIndex ?? 0,
      paneIndex: pane.paneIndex ?? 0,
      ...(pane.windowName === undefined ? {} : { windowName: pane.windowName }),
      dead: pane.dead ?? false,
    });
    this.sessions.add(pane.sessionName);
    return paneId;
  }

  killPane(paneId: string): void {
    const pane = this.panes.get(paneId);
    if (pane) pane.dead = true;
  }

  removePane(paneId: string): void {
    this.panes.delete(paneId);
  }

  /** Simulates a full tmux server restart: every pane id is dropped and the counter resets. */
  restartServer(): void {
    this.panes.clear();
    this.paneSeq = 0;
  }

  removeSession(name: string): void {
    this.sessions.delete(name);
    for (const [id, pane] of this.panes) {
      if (pane.sessionName === name) this.panes.delete(id);
    }
  }

  async isAvailable(): Promise<boolean> {
    return this.available;
  }

  async version(): Promise<string> {
    return 'tmux 3.4 (fake)';
  }

  async listSessions(): Promise<TmuxSessionInfo[]> {
    return [...this.sessions].map((name) => ({ name, windows: 1, attached: false }));
  }

  async hasSession(name: string): Promise<boolean> {
    return this.sessions.has(name);
  }

  async listPanes(): Promise<TmuxPaneInfo[]> {
    return [...this.panes.values()].map(
      ({ paneId, sessionName, windowIndex, paneIndex, windowName, dead }) => ({
        paneId,
        sessionName,
        windowIndex,
        paneIndex,
        windowName,
        dead,
      }),
    );
  }

  async paneInfo(target: string): Promise<TmuxPaneInfo | undefined> {
    if (target.startsWith('%')) {
      const pane = this.panes.get(target);
      return pane ? { ...pane } : undefined;
    }
    if (target.startsWith('=')) {
      const body = target.slice(1);
      const colon = body.indexOf(':');
      // A bare "=session" (no window.pane) mirrors the real tmux gotcha: it
      // does not resolve to a pane even though `has-session` accepts it.
      if (colon === -1) return undefined;
      const sessionName = body.slice(0, colon);
      const [windowRaw, paneRaw] = body.slice(colon + 1).split('.');
      const windowIndex = Number(windowRaw ?? '0');
      const paneIndex = Number(paneRaw ?? '0');
      const found = [...this.panes.values()].find(
        (p) =>
          p.sessionName === sessionName &&
          p.windowIndex === windowIndex &&
          p.paneIndex === paneIndex,
      );
      return found ? { ...found } : undefined;
    }
    // Bare session name: mirror tmux's own fallback to that session's pane.
    const found = [...this.panes.values()].find((p) => p.sessionName === target);
    return found ? { ...found } : undefined;
  }

  async sendText(session: string, text: string, options: { submit?: boolean } = {}): Promise<void> {
    const sent: SentText = { session, text, submit: options.submit !== false };
    this.sentText.push(sent);
    await this.onDispatch?.(sent);
  }

  async sendKeys(session: string, keys: readonly string[]): Promise<void> {
    this.sentKeys.push({ session, keys: [...keys] });
  }

  async setBuffer(text: string): Promise<void> {
    this.buffers.push(text);
  }

  async pasteBuffer(target: string, options: { delete?: boolean } = {}): Promise<void> {
    this.pastes.push({ target, deleted: options.delete !== false });
    const text = this.buffers.at(-1) ?? '';
    const sent: SentText = { session: target, text, submit: false };
    this.sentText.push(sent);
    await this.onDispatch?.(sent);
  }

  async capturePane(target: string): Promise<string> {
    if (this.paneContents.has(target)) return this.paneContents.get(target) ?? '';
    // Tests key paneContents by session name for readability; fall back to
    // resolving the pane's session so a %id target still finds it.
    const pane = this.panes.get(target);
    if (pane) return this.paneContents.get(pane.sessionName) ?? '';
    return '';
  }

  async newSession(name: string): Promise<void> {
    this.addSession(name);
  }

  async killSession(name: string): Promise<void> {
    this.removeSession(name);
  }
}

export interface TestProject {
  root: string;
  workspace: Workspace;
  tmux: FakeTmuxClient;
  cleanup: () => Promise<void>;
}

let counter = 0;

export async function makeTempDir(prefix = 'agentctl-test'): Promise<string> {
  counter += 1;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-${process.pid}-${counter}-`));
  return dir;
}

/** Creates an initialised project in a temp directory with a fake tmux. */
export async function createTestProject(
  options: { name?: string; sessions?: string[] } = {},
): Promise<TestProject> {
  const base = await makeTempDir();
  const root = path.join(base, options.name ?? 'proj');
  await ProjectStore.init({ name: options.name ?? 'proj', rootPath: root });
  const tmux = new FakeTmuxClient(options.sessions ?? []);
  const workspace = await Workspace.load(root, tmux);
  return {
    root,
    workspace,
    tmux,
    cleanup: async () => {
      await fs.rm(base, { recursive: true, force: true });
    },
  };
}

export async function registerCoordinator(
  project: TestProject,
  overrides: Partial<{ id: string; session: string; model: string; effort: string }> = {},
) {
  const session = overrides.session ?? 'coord';
  project.tmux.addSession(session);
  return project.workspace.agents.register({
    id: overrides.id ?? 'coordinator',
    role: 'coordinator',
    provider: 'codex',
    model: overrides.model ?? 'gpt-5-codex',
    reasoningEffort: overrides.effort ?? 'medium',
    tmuxSession: session,
  });
}

export async function registerWorker(
  project: TestProject,
  overrides: Partial<{ id: string; session: string; parent: string; model: string }> = {},
) {
  const session = overrides.session ?? 'research';
  project.tmux.addSession(session);
  return project.workspace.agents.register({
    id: overrides.id ?? 'researcher',
    role: 'agent',
    provider: 'claude-code',
    model: overrides.model ?? 'sonnet',
    tmuxSession: session,
    parentId: overrides.parent ?? 'coordinator',
  });
}

let tmuxProbe: boolean | undefined;

/** Integration tests only run where a real tmux binary is available. */
export async function tmuxAvailable(): Promise<boolean> {
  if (tmuxProbe !== undefined) return tmuxProbe;
  try {
    await execa(process.env['AGENTCTL_TMUX_BIN'] ?? 'tmux', ['-V']);
    tmuxProbe = true;
  } catch {
    tmuxProbe = false;
  }
  return tmuxProbe;
}
