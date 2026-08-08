import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { execa } from 'execa';

import { ProjectStore } from '../src/app/projectStore.js';
import { Workspace } from '../src/app/workspace.js';
import { type TmuxClient, type TmuxSessionInfo } from '../src/infra/tmux/tmux.js';

export interface SentText {
  session: string;
  text: string;
  submit: boolean;
}

/**
 * In-memory tmux stand-in. `onDispatch` lets a test simulate the AI client
 * reacting to the prompt it was sent (e.g. writing the response file).
 */
export class FakeTmuxClient implements TmuxClient {
  readonly sentText: SentText[] = [];
  readonly sentKeys: { session: string; keys: string[] }[] = [];
  paneContents = new Map<string, string>();
  onDispatch?: (sent: SentText) => void | Promise<void>;
  available = true;

  constructor(private sessions = new Set<string>()) {}

  addSession(name: string): void {
    this.sessions.add(name);
  }

  removeSession(name: string): void {
    this.sessions.delete(name);
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

  async sendText(session: string, text: string, options: { submit?: boolean } = {}): Promise<void> {
    const sent: SentText = { session, text, submit: options.submit !== false };
    this.sentText.push(sent);
    await this.onDispatch?.(sent);
  }

  async sendKeys(session: string, keys: readonly string[]): Promise<void> {
    this.sentKeys.push({ session, keys: [...keys] });
  }

  async capturePane(session: string): Promise<string> {
    return this.paneContents.get(session) ?? '';
  }

  async newSession(name: string): Promise<void> {
    this.sessions.add(name);
  }

  async killSession(name: string): Promise<void> {
    this.sessions.delete(name);
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
  const tmux = new FakeTmuxClient(new Set(options.sessions ?? []));
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
