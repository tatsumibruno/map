import { type Command } from 'commander';

import { GlobalConfigStore } from '../app/globalConfig.js';
import { Workspace, type WorkspaceSelector } from '../app/workspace.js';
import { createTmuxClient, type TmuxClient } from '../infra/tmux/tmux.js';

export interface GlobalOptions {
  project?: string;
  path?: string;
  json?: boolean;
}

/** Global options are declared on the root program and inherited by leaves. */
export function globalOptions(command: Command): GlobalOptions {
  return command.optsWithGlobals<GlobalOptions>();
}

export function selectorFrom(options: GlobalOptions): WorkspaceSelector {
  return {
    project: options.project,
    path: options.path,
    cwd: process.cwd(),
  };
}

let tmuxClient: TmuxClient | undefined;

/** Single tmux client per process; overridable so tests can inject a fake. */
export function tmux(): TmuxClient {
  tmuxClient ??= createTmuxClient();
  return tmuxClient;
}

export function setTmuxClient(client: TmuxClient | undefined): void {
  tmuxClient = client;
}

export async function openWorkspace(command: Command): Promise<Workspace> {
  return Workspace.resolve(selectorFrom(globalOptions(command)), tmux());
}

export function config(): GlobalConfigStore {
  return new GlobalConfigStore();
}
