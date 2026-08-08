import path from 'node:path';

import { Command } from 'commander';

import { ProjectStore } from '../../app/projectStore.js';
import { Workspace } from '../../app/workspace.js';
import { PROVIDER_IDS, getProvider } from '../../providers/registry.js';
import { config, globalOptions, openWorkspace, tmux } from '../context.js';
import { print, printJson, style, table } from '../output.js';

export function projectCommand(): Command {
  const project = new Command('project').description('Create, list and select projects');

  project
    .command('init')
    .argument('<name>', 'project name')
    .option('--path <directory>', 'project root (defaults to ./<name>)')
    .description('Create a project and its .agentctl state directory')
    .action(async (name: string, options: { path?: string }, command: Command) => {
      const rootPath = path.resolve(options.path ?? path.join(process.cwd(), name));
      const { project: created, paths } = await ProjectStore.init({ name, rootPath });

      const workspace = await Workspace.load(created.rootPath, tmux());
      await workspace.events.emit({
        type: 'project.created',
        actor: 'cli',
        subject: created.name,
        data: { rootPath: created.rootPath },
      });
      await config().registerProject(created.name, created.rootPath);

      if (globalOptions(command).json === true) {
        printJson(created);
        return;
      }
      print(`${style.green('✔')} Created project ${style.bold(created.name)} (${created.id})`);
      print(`  state directory: ${paths.state}`);
      print('');
      print('Next steps:');
      print(`  1. Start a tmux session and sign in to your AI client manually:`);
      print(style.dim(`       tmux new -s coord   # then run: codex`));
      print(`  2. Register that session:`);
      print(
        style.dim(
          `       agentctl agent register coordinator --project ${created.name} --role coordinator \\\n` +
            `         --provider codex --model gpt-5-codex --tmux coord`,
        ),
      );
    });

  project
    .command('list')
    .description('List registered projects')
    .action(async (_options: unknown, command: Command) => {
      const store = config();
      const projects = await store.listProjects();
      const active = await store.activeProject();

      if (globalOptions(command).json === true) {
        printJson({ activeProject: active ?? null, projects });
        return;
      }
      if (projects.length === 0) {
        print('No projects registered. Create one with `agentctl project init <name>`.');
        return;
      }
      print(
        table(
          ['', 'NAME', 'ROOT'],
          projects.map((p) => [p.name === active ? style.green('*') : ' ', p.name, p.rootPath]),
        ),
      );
    });

  project
    .command('use')
    .argument('<name>', 'project name')
    .option('--path <directory>', 'register this root path for the project first')
    .description('Select the active project')
    .action(async (name: string, options: { path?: string }, command: Command) => {
      const store = config();
      if (options.path) {
        const { project: loaded } = await ProjectStore.load(options.path);
        await store.registerProject(name, loaded.rootPath);
      }
      await store.setActiveProject(name);
      const rootPath = await store.resolveProjectPath(name);

      if (globalOptions(command).json === true) {
        printJson({ activeProject: name, rootPath });
        return;
      }
      print(`${style.green('✔')} Active project is now ${style.bold(name)} (${rootPath})`);
    });

  const context = new Command('context').description('Manage shared project context');

  context
    .command('add')
    .argument('<file>', 'file to copy into the project context')
    .option('--as <name>', 'store it under a different file name')
    .option('--allow-outside-root', 'permit sources outside the project root', false)
    .description('Add a shared context file')
    .action(
      async (
        file: string,
        options: { as?: string; allowOutsideRoot?: boolean },
        command: Command,
      ) => {
        const workspace = await openWorkspace(command);
        const entry = await workspace.context.add(file, {
          ...(options.as === undefined ? {} : { as: options.as }),
          allowOutsideRoot: options.allowOutsideRoot === true,
        });
        await workspace.events.emit({
          type: 'project.context.added',
          actor: 'cli',
          subject: entry.ref,
          data: { bytes: entry.bytes },
        });

        if (globalOptions(command).json === true) {
          printJson(entry);
          return;
        }
        print(`${style.green('✔')} Added context ${style.bold(entry.ref)} (${entry.bytes} bytes)`);
      },
    );

  context
    .command('list')
    .description('List shared context files')
    .action(async (_options: unknown, command: Command) => {
      const workspace = await openWorkspace(command);
      const entries = await workspace.context.list();

      if (globalOptions(command).json === true) {
        printJson(entries);
        return;
      }
      if (entries.length === 0) {
        print('No context files. Add one with `agentctl project context add <file>`.');
        return;
      }
      print(
        table(
          ['REF', 'BYTES'],
          entries.map((e) => [e.ref, String(e.bytes)]),
        ),
      );
    });

  project.addCommand(context);

  const model = new Command('model').description('Manage the per-project model allow-list');

  model
    .command('allow')
    .argument('<provider>', `provider (${PROVIDER_IDS.join('|')})`)
    .argument('<model>', 'model identifier to accept for this provider')
    .description('Accept a model id the built-in catalog does not know yet')
    .action(async (providerId: string, modelId: string, _options: unknown, command: Command) => {
      const provider = getProvider(providerId);
      const workspace = await openWorkspace(command);
      const updated = await ProjectStore.allowModel(
        workspace.project.rootPath,
        provider.id,
        modelId,
      );

      if (globalOptions(command).json === true) {
        printJson(updated.providerModelOverrides ?? {});
        return;
      }
      print(`${style.green('✔')} "${modelId}" is now accepted for provider ${provider.id}`);
    });

  model
    .command('list')
    .option('--provider <provider>', `restrict to one provider (${PROVIDER_IDS.join('|')})`)
    .description('List the models each provider accepts in this project')
    .action(async (options: { provider?: string }, command: Command) => {
      const workspace = await openWorkspace(command);
      const providers = options.provider
        ? [getProvider(options.provider)]
        : PROVIDER_IDS.map(getProvider);
      const rows: string[][] = [];
      for (const adapter of providers) {
        const extra = workspace.project.providerModelOverrides?.[adapter.id] ?? [];
        for (const descriptor of adapter.listModels()) {
          rows.push([
            adapter.id,
            descriptor.id,
            descriptor.reasoningEfforts.join(',') || '—',
            'built-in',
          ]);
        }
        for (const id of extra) {
          rows.push([adapter.id, id, adapter.listReasoningEfforts(id).join(',') || '—', 'project']);
        }
      }

      if (globalOptions(command).json === true) {
        printJson(
          rows.map(([provider, id, efforts, source]) => ({
            provider,
            model: id,
            reasoningEfforts: efforts,
            source,
          })),
        );
        return;
      }
      print(table(['PROVIDER', 'MODEL', 'REASONING EFFORTS', 'SOURCE'], rows));
    });

  project.addCommand(model);

  return project;
}
