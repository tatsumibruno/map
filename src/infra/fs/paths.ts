import os from 'node:os';
import path from 'node:path';

/** Name of the per-project state directory. */
export const STATE_DIR_NAME = '.agentctl';

export interface ProjectPaths {
  root: string;
  state: string;
  projectFile: string;
  contextDir: string;
  agentsDir: string;
  mailboxesDir: string;
  tasksDir: string;
  runnersDir: string;
  logsDir: string;
  eventsFile: string;
  locksDir: string;
}

export function projectPaths(rootPath: string): ProjectPaths {
  const root = path.resolve(rootPath);
  const state = path.join(root, STATE_DIR_NAME);
  return {
    root,
    state,
    projectFile: path.join(state, 'project.json'),
    contextDir: path.join(state, 'context'),
    agentsDir: path.join(state, 'agents'),
    mailboxesDir: path.join(state, 'mailboxes'),
    tasksDir: path.join(state, 'tasks'),
    runnersDir: path.join(state, 'runners'),
    logsDir: path.join(state, 'logs'),
    eventsFile: path.join(state, 'events.jsonl'),
    locksDir: path.join(state, 'locks'),
  };
}

export interface MailboxPaths {
  dir: string;
  inbox: string;
  outbox: string;
  status: string;
  cursor: string;
  workDir: string;
}

export function mailboxPaths(rootPath: string, agentId: string): MailboxPaths {
  const dir = path.join(projectPaths(rootPath).mailboxesDir, agentId);
  return {
    dir,
    inbox: path.join(dir, 'inbox.jsonl'),
    outbox: path.join(dir, 'outbox.jsonl'),
    status: path.join(dir, 'status.json'),
    cursor: path.join(dir, 'cursor.json'),
    workDir: path.join(dir, 'work'),
  };
}

export function agentFile(rootPath: string, agentId: string): string {
  return path.join(projectPaths(rootPath).agentsDir, `${agentId}.json`);
}

export function taskFile(rootPath: string, taskId: string): string {
  return path.join(projectPaths(rootPath).tasksDir, `${taskId}.json`);
}

export function runnerFile(rootPath: string, agentId: string): string {
  return path.join(projectPaths(rootPath).runnersDir, `${agentId}.json`);
}

export function runnerLogFile(rootPath: string, agentId: string): string {
  return path.join(projectPaths(rootPath).logsDir, `runner-${agentId}.log`);
}

/** Root of the user-level config (project registry + active project). */
export function globalConfigDir(): string {
  const override = process.env['AGENTCTL_HOME'];
  if (override && override.trim() !== '') return path.resolve(override);
  return path.join(os.homedir(), '.agentctl');
}

export function globalConfigFile(): string {
  return path.join(globalConfigDir(), 'config.json');
}

/**
 * True when `candidate` resolves to `root` itself or something below it.
 * Used to keep context references inside the project root.
 */
export function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
