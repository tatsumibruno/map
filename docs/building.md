# Building the CLI

How to compile `agentctl`, get it onto your `PATH`, package it, and diagnose
build problems.

## Requirements

| | Version | Why |
| --- | --- | --- |
| Node.js (to run) | **18.18+** | ESM, `AbortSignal` on timers, `node:test`-era APIs |
| Node.js (to develop) | **20.19+** | Vitest 4 needs `node:util`'s `styleText` |
| npm | 9+ | ships with Node 18 |
| tmux | 3.0+ | runtime only — not needed to build |

The published CLI still runs on Node 18.18+; only the test toolchain needs a
newer Node. `.nvmrc` pins the version this repo is developed against, so
`nvm use` in the project root picks it up.

Check what you have:

```bash
node --version   # v18.18.0+ to run, v20.19.0+ to run the tests
npm --version
tmux -V          # optional at build time
```

## The short version

```bash
git clone <repo> && cd map
npm install
npm run build
node dist/bin/agentctl.js --version
```

That is the whole build. `npm run build` is `tsc -p tsconfig.build.json` — no
bundler, no codegen, no post-processing.

## What the build produces

TypeScript compiles `src/` to `dist/`, preserving the directory structure and
emitting ES modules (`package.json` has `"type": "module"`), plus `.d.ts`
declarations and source maps.

```text
dist/
├── bin/agentctl.js        the executable entry point (has the #! line)
├── index.js               the public API, for embedding agentctl
├── app/  cli/  core/  domain/  infra/  providers/  runner/
└── *.d.ts, *.js.map
```

Two things to know about the output:

- **Imports keep their `.js` extensions.** Node's ESM resolver requires explicit
  extensions, so the source imports `./foo.js` even though the file is `foo.ts`.
  That is correct and intentional — do not "fix" it.
- **`dist/bin/agentctl.js` is the real entry point.** `runner start` re-execs
  *this exact file* to spawn detached workers, which is why a stale or missing
  `dist/` breaks runners specifically. See [Troubleshooting](#troubleshooting).

## Build scripts

| Command | What it does |
| --- | --- |
| `npm run build` | compile `src/` → `dist/` |
| `npm run dev` | same, in `--watch` mode |
| `npm run typecheck` | type-check `src/` **and** `test/` without emitting |
| `npm run lint` | ESLint, type-aware rules |
| `npm run lint:fix` | ESLint with `--fix` |
| `npm run format` | Prettier, write |
| `npm run format:check` | Prettier, verify only |
| `npm test` | Vitest, single run |
| `npm run test:watch` | Vitest, watch mode |
| `npm run test:coverage` | Vitest with v8 coverage |
| `npm run check` | typecheck + lint + test — run this before committing |
| `npm start` | run the built CLI |

There are two tsconfigs on purpose:

- **`tsconfig.json`** includes `src/` and `test/`. It is what `typecheck`, your
  editor, and Vitest use.
- **`tsconfig.build.json`** narrows `rootDir` to `src/` and excludes tests, so
  `dist/` contains only shippable code (and `dist/src/…` never happens).

The compiler settings are deliberately strict: `strict`, plus
`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`,
`noUnusedLocals`, and `isolatedModules`. If you are surprised by an error about
`T | undefined` on an optional property, that is `exactOptionalPropertyTypes`
doing its job — declare optional fields as `?: T | undefined` to match what zod
infers.

## Getting `agentctl` on your PATH

### Development: `npm link`

```bash
npm run build
npm link
agentctl --version
agentctl doctor
```

`npm link` symlinks the package globally, so the `agentctl` command points at
your working copy. Rebuild after changing source; the symlink stays valid.

Undo it with `npm unlink -g agentctl`.

### Without linking

```bash
node /path/to/map/dist/bin/agentctl.js --version

# or an alias
alias agentctl='node /path/to/map/dist/bin/agentctl.js'
```

### Installing a packaged tarball

```bash
npm pack                          # → agentctl-0.1.0.tgz
npm install -g ./agentctl-0.1.0.tgz
```

`npm pack` runs `prepublishOnly`, which builds first, so the tarball always
contains a fresh `dist/`. The `files` field limits it to `dist/`, `README.md`,
and `LICENSE` — no sources, no tests.

## Building the Docker image

The image exists for the container topology: a coordinator and agent workers in
separate containers sharing one project volume.

```bash
npm run build            # the Dockerfile copies dist/, it does not compile
docker build -t agentctl:0.1.0 .
docker run --rm agentctl:0.1.0 --version
```

The image is `node:20-bookworm-slim` plus tmux, with production dependencies
only and `agentctl` symlinked onto the `PATH`. It contains **no credentials** —
you authenticate inside the container's tmux session by hand, exactly as on the
host.

```bash
docker compose build
docker compose up
docker compose exec researcher tmux attach -t research   # then sign in
```

`.dockerignore` excludes `src/`, `test/`, and `node_modules/`, so the build
context stays small and the image ships only compiled output.

## Shell completion

Completion scripts are **generated by the built CLI**, not checked in, so they
always match the commands the binary actually has:

```bash
agentctl completion bash | sudo tee /etc/bash_completion.d/agentctl >/dev/null
agentctl completion zsh > "${fpath[1]}/_agentctl" && autoload -Uz compinit && compinit
agentctl completion fish > ~/.config/fish/completions/agentctl.fish
```

`agentctl completion <shell> --instructions` prints those steps for the shell
you name. Regenerate after upgrading.

## Verifying a build

```bash
npm run check                              # types + lint + tests
node dist/bin/agentctl.js --version
node dist/bin/agentctl.js doctor
node dist/bin/agentctl.js completion bash | head -5
```

`doctor` is the real smoke test: it checks the Node version, finds tmux, and —
if a project is in scope — validates the state directory, every registration,
runner liveness, malformed files, and stale locks. It exits `8` on failure, so
it works in CI.

## Troubleshooting

**`Cannot find module '.../dist/bin/agentctl.js'`**
You have not built, or `dist/` is stale. Run `npm run build`. This bites hardest
with `runner start`, because the supervisor re-execs that exact path.

**`ERR_MODULE_NOT_FOUND` for a relative import**
An import is missing its `.js` extension. ESM requires it, even in TypeScript
sources. Add it.

**`SyntaxError: The requested module 'node:util' does not provide an export named 'styleText'`**
`npx` fetched a newer tool than your Node supports. Use the local binaries:
`npm test`, or `node node_modules/vitest/vitest.mjs run`.

**`error TS2375` / `TS2379` about `undefined` on an optional property**
`exactOptionalPropertyTypes` is on. Declare the property `?: T | undefined`, or
build the object conditionally: `...(x === undefined ? {} : { x })`.

**ESLint complains it cannot find a tsconfig for a file**
The type-aware rules need the file inside `tsconfig.json`'s `include`. New
top-level directories may need adding there.

**Runners start and immediately die**
Read `.agentctl/logs/runner-<agent>.log`. Usually a stale `dist/`, or tmux not
on the runner's `PATH` — set `AGENTCTL_TMUX_BIN`.

## Environment variables

| Variable | Effect |
| --- | --- |
| `AGENTCTL_HOME` | where the user-level project registry lives (default `~/.agentctl`) |
| `AGENTCTL_TMUX_BIN` | path to the tmux binary (default `tmux`) |
| `AGENTCTL_CLI_ENTRY` | override the entry point re-exec'd for detached runners |
| `AGENTCTL_DEBUG=1` | print stack traces instead of one-line errors |
| `NO_COLOR` / `AGENTCTL_NO_COLOR` | disable ANSI colour |

`AGENTCTL_HOME` is also the clean way to isolate an experiment: point it at a
temp directory and your real project registry is untouched.

## Releasing

```bash
npm run check                       # must be green
npm version <patch|minor|major>     # bump package.json + tag
npm run build
npm publish                         # prepublishOnly rebuilds
```

Keep `VERSION` in `src/cli/index.ts` in step with `package.json` — it is what
`agentctl --version` prints.
