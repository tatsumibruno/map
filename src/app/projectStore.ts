import fs from 'node:fs/promises';
import path from 'node:path';

import { ConflictError, NotFoundError, ValidationError } from '../core/errors.js';
import { newProjectId } from '../core/ids.js';
import { nowIso } from '../core/time.js';
import { identifierSchema, projectSchema } from '../domain/schemas.js';
import { SCHEMA_VERSION, type Project, type ProviderId } from '../domain/types.js';
import {
  ensureDir,
  formatZodIssues,
  pathExists,
  readJsonFile,
  writeJsonAtomic,
} from '../infra/fs/atomic.js';
import { withLock } from '../infra/fs/lock.js';
import { isInside, projectPaths, STATE_DIR_NAME, type ProjectPaths } from '../infra/fs/paths.js';

const CONTEXT_README = `# Project context

Files in this directory are shared with every agent registered to this project.

Guidelines:

- Keep each file focused and short. Agents receive **references**, not copies.
- \`shared.md\` is included in every dispatch by default.
- Anything secret does not belong here: this directory is read by every agent.
`;

const SHARED_MD = `# Shared context

Describe the project, its conventions, and anything every agent should know
before starting work. Replace this text.
`;

export interface InitProjectInput {
  name: string;
  rootPath: string;
}

export class ProjectStore {
  static async init(input: InitProjectInput): Promise<{ project: Project; paths: ProjectPaths }> {
    const nameCheck = identifierSchema.safeParse(input.name);
    if (!nameCheck.success) {
      throw new ValidationError(
        `Invalid project name "${input.name}"`,
        formatZodIssues(nameCheck.error),
      );
    }

    const paths = projectPaths(input.rootPath);
    if (await pathExists(paths.projectFile)) {
      const existing = await readJsonFile(paths.projectFile, projectSchema);
      throw new ConflictError(
        `${paths.root} already hosts project "${existing.name}"`,
        'Use `agentctl project use` to select it, or choose a different --path.',
      );
    }

    const project: Project = {
      id: newProjectId(),
      name: input.name,
      rootPath: paths.root,
      createdAt: nowIso(),
      schemaVersion: SCHEMA_VERSION,
    };

    for (const dir of [
      paths.state,
      paths.contextDir,
      paths.agentsDir,
      paths.mailboxesDir,
      paths.tasksDir,
      paths.runnersDir,
      paths.logsDir,
      paths.locksDir,
    ]) {
      await ensureDir(dir);
    }

    await writeJsonAtomic(paths.projectFile, project);
    await fs.writeFile(path.join(paths.contextDir, 'README.md'), CONTEXT_README, 'utf8');
    await fs.writeFile(path.join(paths.contextDir, 'shared.md'), SHARED_MD, 'utf8');
    await fs.appendFile(paths.eventsFile, '', 'utf8');
    await fs.writeFile(path.join(paths.locksDir, '.gitkeep'), '', 'utf8');

    return { project, paths };
  }

  static async load(rootPath: string): Promise<{ project: Project; paths: ProjectPaths }> {
    const paths = projectPaths(rootPath);
    if (!(await pathExists(paths.projectFile))) {
      throw new NotFoundError(
        `No agentctl project found at ${paths.root}`,
        `Expected ${path.join(STATE_DIR_NAME, 'project.json')}. Run \`agentctl project init <name>\` first.`,
      );
    }
    const project = await readJsonFile(paths.projectFile, projectSchema);
    // The directory may have been moved; trust the location on disk.
    return { project: { ...project, rootPath: paths.root }, paths };
  }

  /** Walks up from `startDir` looking for a `.agentctl/project.json`. */
  static async discover(startDir: string): Promise<string | undefined> {
    let current = path.resolve(startDir);
    for (;;) {
      if (await pathExists(path.join(current, STATE_DIR_NAME, 'project.json'))) return current;
      const parent = path.dirname(current);
      if (parent === current) return undefined;
      current = parent;
    }
  }

  static async save(rootPath: string, project: Project): Promise<void> {
    const paths = projectPaths(rootPath);
    await writeJsonAtomic(paths.projectFile, project);
  }

  static async allowModel(rootPath: string, provider: ProviderId, model: string): Promise<Project> {
    const paths = projectPaths(rootPath);
    return withLock(paths.locksDir, 'project', async () => {
      const project = await readJsonFile(paths.projectFile, projectSchema);
      const overrides = { ...(project.providerModelOverrides ?? {}) };
      const current = overrides[provider] ?? [];
      if (!current.includes(model)) overrides[provider] = [...current, model];
      const next: Project = { ...project, providerModelOverrides: overrides };
      await writeJsonAtomic(paths.projectFile, next);
      return next;
    });
  }
}

export interface ContextEntry {
  /** Path relative to the project root, e.g. `.agentctl/context/shared.md`. */
  ref: string;
  absolutePath: string;
  bytes: number;
}

export class ContextStore {
  private readonly paths: ProjectPaths;

  constructor(private readonly rootPath: string) {
    this.paths = projectPaths(rootPath);
  }

  async list(): Promise<ContextEntry[]> {
    if (!(await pathExists(this.paths.contextDir))) return [];
    const names = await fs.readdir(this.paths.contextDir);
    const entries: ContextEntry[] = [];
    for (const name of names.sort()) {
      const absolutePath = path.join(this.paths.contextDir, name);
      const stat = await fs.stat(absolutePath);
      if (!stat.isFile()) continue;
      entries.push({
        ref: path.relative(this.paths.root, absolutePath),
        absolutePath,
        bytes: stat.size,
      });
    }
    return entries;
  }

  /**
   * Copies `sourcePath` into the project context directory. Sources outside
   * the project root are refused unless `allowOutsideRoot` is set explicitly
   * (§16: context paths are restricted to the project root by default).
   */
  async add(
    sourcePath: string,
    options: { allowOutsideRoot?: boolean; as?: string } = {},
  ): Promise<ContextEntry> {
    const absoluteSource = path.resolve(sourcePath);
    if (!(await pathExists(absoluteSource))) {
      throw new NotFoundError(`Context file not found: ${absoluteSource}`);
    }
    const stat = await fs.stat(absoluteSource);
    if (!stat.isFile()) {
      throw new ValidationError(`${absoluteSource} is not a regular file`);
    }
    if (!isInside(this.paths.root, absoluteSource) && options.allowOutsideRoot !== true) {
      throw new ValidationError(
        `${absoluteSource} is outside the project root ${this.paths.root}`,
        'Pass --allow-outside-root to copy it in anyway.',
      );
    }

    const targetName = options.as ?? path.basename(absoluteSource);
    const nameCheck = /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(targetName);
    if (!nameCheck) {
      throw new ValidationError(
        `Invalid context file name "${targetName}"`,
        'Use letters, digits, ".", "_" or "-" only.',
      );
    }

    const target = path.join(this.paths.contextDir, targetName);
    if (!isInside(this.paths.contextDir, target)) {
      throw new ValidationError('Refusing to write a context file outside the context directory');
    }

    await ensureDir(this.paths.contextDir);
    if (absoluteSource !== target) {
      await fs.copyFile(absoluteSource, target);
    }
    const finalStat = await fs.stat(target);
    return {
      ref: path.relative(this.paths.root, target),
      absolutePath: target,
      bytes: finalStat.size,
    };
  }

  /** Default references attached to every dispatch. */
  async defaultRefs(): Promise<string[]> {
    const entries = await this.list();
    return entries
      .filter((e) => e.ref.endsWith('.md') && !e.ref.endsWith('README.md'))
      .map((e) => e.ref);
  }

  get dir(): string {
    return this.paths.contextDir;
  }

  get root(): string {
    return this.rootPath;
  }
}
