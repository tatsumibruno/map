# Testing

How the suite is organised, how to run it, and the patterns to follow when
adding to it.

## Running

```bash
npm test                 # single run
npm run test:watch       # watch mode
npm run test:coverage    # v8 coverage
npm run check            # typecheck + lint + test
```

If `npx vitest` misbehaves on Node 18, use the local binary — `npx` will happily
fetch a newer Vitest that your Node cannot load:

```bash
node node_modules/vitest/vitest.mjs run
node node_modules/vitest/vitest.mjs run test/app        # one directory
node node_modules/vitest/vitest.mjs run -t "cycle"      # by name
```

## Layout

```text
test/
├── helpers.ts                     FakeTmuxClient, temp projects, tmux probe
├── domain/hierarchy.test.ts       routing, cycles, parent rules, tree rendering
├── infra/persistence.test.ts      atomic writes, JSONL offsets, locks, paths
├── providers/adapters.test.ts     model/effort validation, envelope contents
├── app/registration.test.ts       project init, registration, lifecycle, restart
├── app/messaging.test.ts          delivery, cursors, task snapshots, redaction
├── app/runnerSupervisor.test.ts   pid handling, detached process lifecycle
├── runner/agentWorker.test.ts     the full task flow, timeouts, cancel, restart
├── cli/cli.test.ts                the CLI end to end, plus completion
└── integration/
    ├── tmux.test.ts               real tmux — self-skipping
    └── sharedVolume.test.ts       the container topology, one shared directory
```

Roughly: `domain/` and `infra/` are unit tests, `app/` and `runner/` are
service-level tests against a real temp filesystem, and `cli/`+`integration/`
are end-to-end.

Nothing is mocked at the module level. Tests write to real temp directories and
inject a fake tmux — so the persistence behaviour under test is the real
behaviour, not a stub's.

## The helpers

### `createTestProject()`

Initialises a real project in a fresh temp directory with a fake tmux, and hands
back a cleanup function:

```ts
let project: TestProject | undefined;
afterEach(async () => {
  await project?.cleanup();
  project = undefined;
});

it('does something', async () => {
  project = await createTestProject({ name: 'product', sessions: ['coord'] });
  await registerCoordinator(project);
  await registerWorker(project);
  // project.workspace is a fully wired Workspace
});
```

`registerCoordinator` / `registerWorker` create the conventional
`coordinator` → `researcher` pair used by most tests.

### `FakeTmuxClient`

An in-memory `TmuxClient` that records what was typed and lets you simulate the
AI client reacting:

```ts
project.tmux.onDispatch = async (sent) => {
  const responsePath = responsePathFrom(sent.text);
  await fs.writeFile(responsePath, 'the answer', 'utf8');
};
```

It exposes `sentText`, `sentKeys`, `paneContents` (for the sentinel fallback
path), and `addSession` / `removeSession` to simulate a session dying.

### `tmuxAvailable()`

Probes for a real tmux binary once per run. Integration tests gate on it:

```ts
const hasTmux = await tmuxAvailable();
describe.skipIf(!hasTmux)('tmux transport integration', () => { /* … */ });
```

That is why the suite is green on machines without tmux — those tests skip
rather than fail, and one always-running test prints a warning so the skip is
visible rather than silent.

## Testing the CLI

`test/cli/cli.test.ts` runs the real `commander` program **in-process**,
capturing stdout/stderr and returning the exit code:

```ts
const result = await cli('agent', 'register', 'coordinator',
  '--project', 'product', '--role', 'coordinator',
  '--provider', 'codex', '--model', 'gpt-5-codex', '--tmux', 'coord');

expect(result.code).toBe(0);
expect(result.err).toContain('...');
```

Each test gets an isolated `AGENTCTL_HOME` and a mocked `process.cwd()`, so the
project registry and directory discovery are exercised for real without touching
your actual `~/.agentctl`.

Use `--json` and parse the output when asserting on structure; it is far more
robust than matching formatted tables.

## Patterns worth copying

**Assert on hints, not just messages.** The actionable half of an error lives in
`error.hint`:

```ts
expect(() => codex.validateExecutionConfig({ model: 'nope' })).toThrow(/not a known Codex model/);
expect(hintOf(() => codex.validateExecutionConfig({ model: 'nope' })))
  .toContain('project model allow codex nope');
```

**Drive the worker with `once: true`.** One deterministic tick, no sleeping:

```ts
await new AgentWorker(workspace, 'researcher', {
  pollIntervalMs: 5,
  responseTimeoutMs: 5_000,
  once: true,
  logger: () => {},
}).run();
```

Always pass `logger: () => {}` so test output stays readable.

**Simulate a restart by rebuilding the `Workspace`.** Nothing survives in
memory, so a fresh instance over the same directory is exactly what a new
process sees:

```ts
const restarted = await Workspace.load(project.root, new FakeTmuxClient(...));
expect((await restarted.tasks.get(task.id)).state).toBe('pending');
```

**Simulate containers with two `Workspace` instances.** Separate handles,
separate fake tmux clients, one shared directory — that is the whole container
topology, and it is what `integration/sharedVolume.test.ts` asserts.

## What is deliberately covered

The suite maps onto the specification's acceptance criteria:

| Criterion | Where |
| --- | --- |
| Project + two registered sessions | `app/registration.test.ts` |
| Session validation, persistence | `app/registration.test.ts` |
| Task assigned through the filesystem | `app/messaging.test.ts`, `cli/cli.test.ts` |
| Runner processes and correlates a response | `runner/agentWorker.test.ts` |
| Coordinator observes without touching the terminal | `runner/agentWorker.test.ts`, `integration/sharedVolume.test.ts` |
| State survives a restart | `app/registration.test.ts` |
| Working bash/zsh/fish completion | `cli/cli.test.ts` |
| No credentials stored or handled | `app/messaging.test.ts` (redaction), and by construction |
| Separate processes over a shared directory | `integration/sharedVolume.test.ts` |
| Model/effort choice, recorded per task | `providers/adapters.test.ts`, `app/messaging.test.ts` |

Failure paths get the same attention as happy paths: missing session, duplicate
session, unsupported model, unsupported effort, bad parent, cycles, disabled
agents, timeouts, cancellation, dead sessions mid-task, corrupt JSONL, and lock
contention.

## Adding a test

1. Put it next to its layer (`domain/`, `app/`, `runner/`, `cli/`).
2. Use `createTestProject()` and register cleanup in `afterEach`.
3. Prefer the real filesystem over mocks — temp dirs are cheap and the
   persistence semantics are the point.
4. If it needs tmux, put it in `integration/` behind `describe.skipIf`.
5. Run `npm run check` before committing — the lint config is type-aware and
   will catch unsafe `any` flowing out of `JSON.parse`.

## CI notes

- `npm run check` is the single gate.
- Install tmux in CI to get the extra integration coverage; without it those
  tests skip and everything else still runs.
- `agentctl doctor` exits `8` on failure, so it works as a post-install
  smoke check in a pipeline.
