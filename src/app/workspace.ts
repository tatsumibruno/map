import { NotFoundError } from '../core/errors.js';
import { type Project } from '../domain/types.js';
import { type ProjectPaths } from '../infra/fs/paths.js';
import { createTmuxClient, type TmuxClient } from '../infra/tmux/tmux.js';
import { AgentRegistry } from './agentRegistry.js';
import { EventLog } from './eventLog.js';
import { GlobalConfigStore } from './globalConfig.js';
import { MessageBus } from './messageBus.js';
import { ContextStore, ProjectStore } from './projectStore.js';
import { TaskService } from './taskService.js';

export interface WorkspaceSelector {
  /** Registered project name. */
  project?: string | undefined;
  /** Explicit project root, bypassing the global registry. */
  path?: string | undefined;
  /** Directory to search upwards from when nothing else is given. */
  cwd?: string | undefined;
}

/**
 * A loaded project plus every service bound to it. Commands take a Workspace
 * rather than reaching for paths themselves, which keeps CLI code free of
 * filesystem details.
 */
export class Workspace {
  private constructor(
    readonly project: Project,
    readonly paths: ProjectPaths,
    readonly tmux: TmuxClient,
    readonly events: EventLog,
    readonly agents: AgentRegistry,
    readonly bus: MessageBus,
    readonly tasks: TaskService,
    readonly context: ContextStore,
  ) {}

  static async load(rootPath: string, tmux: TmuxClient = createTmuxClient()): Promise<Workspace> {
    const { project, paths } = await ProjectStore.load(rootPath);
    const events = new EventLog(project.rootPath, project.id);
    const bus = new MessageBus(project, events);
    return new Workspace(
      project,
      paths,
      tmux,
      events,
      new AgentRegistry(project, tmux),
      bus,
      new TaskService(project, bus, events),
      new ContextStore(project.rootPath),
    );
  }

  /**
   * Resolution order: `--path`, then `--project`, then the nearest project at
   * or above `cwd`, then the active project from the global config.
   */
  static async resolve(
    selector: WorkspaceSelector = {},
    tmux: TmuxClient = createTmuxClient(),
    config: GlobalConfigStore = new GlobalConfigStore(),
  ): Promise<Workspace> {
    if (selector.path) return Workspace.load(selector.path, tmux);

    if (selector.project) {
      return Workspace.load(await config.resolveProjectPath(selector.project), tmux);
    }

    const discovered = await ProjectStore.discover(selector.cwd ?? process.cwd());
    if (discovered) return Workspace.load(discovered, tmux);

    const active = await config.activeProject();
    if (active) return Workspace.load(await config.resolveProjectPath(active), tmux);

    throw new NotFoundError(
      'No project selected and none found in the current directory',
      'Pass --project <name>, run from inside a project, or run `agentctl project use <name>`.',
    );
  }
}
