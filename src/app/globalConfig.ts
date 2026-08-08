import path from 'node:path';

import { NotFoundError } from '../core/errors.js';
import { nowIso } from '../core/time.js';
import { globalConfigSchema, type GlobalConfig } from '../domain/schemas.js';
import { SCHEMA_VERSION } from '../domain/types.js';
import { readJsonFileIfExists, writeJsonAtomic } from '../infra/fs/atomic.js';
import { globalConfigDir, globalConfigFile } from '../infra/fs/paths.js';
import { withLock } from '../infra/fs/lock.js';

const EMPTY: GlobalConfig = { schemaVersion: SCHEMA_VERSION, projects: [] };

/**
 * User-level registry of known projects plus the active-project selection.
 * Deliberately tiny: all real state lives in each project's `.agentctl/`.
 */
export class GlobalConfigStore {
  constructor(private readonly file: string = globalConfigFile()) {}

  private get locksDir(): string {
    return path.join(globalConfigDir(), 'locks');
  }

  async read(): Promise<GlobalConfig> {
    return (await readJsonFileIfExists(this.file, globalConfigSchema)) ?? EMPTY;
  }

  private async update(mutate: (config: GlobalConfig) => GlobalConfig): Promise<GlobalConfig> {
    return withLock(this.locksDir, 'global-config', async () => {
      const current = await this.read();
      const next = mutate(current);
      await writeJsonAtomic(this.file, next);
      return next;
    });
  }

  async registerProject(name: string, rootPath: string): Promise<void> {
    const resolved = path.resolve(rootPath);
    await this.update((config) => ({
      ...config,
      projects: [
        ...config.projects.filter((p) => p.name !== name),
        { name, rootPath: resolved, registeredAt: nowIso() },
      ].sort((a, b) => a.name.localeCompare(b.name)),
      activeProject: config.activeProject ?? name,
    }));
  }

  async forgetProject(name: string): Promise<void> {
    await this.update((config) => {
      const projects = config.projects.filter((p) => p.name !== name);
      const next: GlobalConfig = { ...config, projects };
      if (config.activeProject === name) delete next.activeProject;
      return next;
    });
  }

  async setActiveProject(name: string): Promise<void> {
    await this.update((config) => {
      if (!config.projects.some((p) => p.name === name)) {
        throw new NotFoundError(
          `Project "${name}" is not registered`,
          'Run `agentctl project list`, or `agentctl project init` to create it.',
        );
      }
      return { ...config, activeProject: name };
    });
  }

  async resolveProjectPath(name: string): Promise<string> {
    const config = await this.read();
    const entry = config.projects.find((p) => p.name === name);
    if (!entry) {
      throw new NotFoundError(
        `Project "${name}" is not registered`,
        'Run `agentctl project list` to see known projects.',
      );
    }
    return entry.rootPath;
  }

  async listProjects(): Promise<GlobalConfig['projects']> {
    return (await this.read()).projects;
  }

  async activeProject(): Promise<string | undefined> {
    return (await this.read()).activeProject;
  }
}
