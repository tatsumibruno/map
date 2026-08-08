/**
 * Completion scripts are generated rather than shipped as static files so the
 * binary name stays configurable. Dynamic values (projects, agents, models,
 * live tmux sessions) are resolved by calling back into `agentctl __complete`,
 * which keeps the shell code small and the catalogs in one place.
 */

export type Shell = 'bash' | 'zsh' | 'fish';

export const COMMAND_TREE: Record<string, readonly string[]> = {
  project: ['init', 'list', 'use', 'context', 'model'],
  'project context': ['add', 'list'],
  'project model': ['allow', 'list'],
  session: ['list'],
  agent: ['register', 'list', 'status', 'configure', 'enable', 'disable', 'remove'],
  message: ['send'],
  task: ['assign', 'watch', 'list', 'cancel'],
  runner: ['start', 'stop', 'status'],
  coordinator: ['start'],
  'agent-worker': ['start'],
};

export const TOP_LEVEL = [
  'project',
  'session',
  'agent',
  'agent-worker',
  'message',
  'task',
  'events',
  'runner',
  'coordinator',
  'doctor',
  'completion',
  'help',
] as const;

/** Flags whose values come from a dynamic `__complete` lookup. */
const DYNAMIC_FLAGS: Record<string, string> = {
  '--project': 'projects',
  '--from': 'agents',
  '--to': 'agents',
  '--parent': 'agents',
  '--tmux': 'sessions',
  '--provider': 'providers',
  '--role': 'roles',
  '--model': 'models',
  '--reasoning-effort': 'efforts',
};

export function bashCompletion(bin: string): string {
  const dynamicCases = Object.entries(DYNAMIC_FLAGS)
    .map(
      ([flag, kind]) => `    ${flag})\n      __agentctl_dynamic ${kind}\n      return 0\n      ;;`,
    )
    .join('\n');

  return `# bash completion for ${bin}
# Install: ${bin} completion bash > /etc/bash_completion.d/${bin}
#      or: ${bin} completion bash >> ~/.bashrc

__agentctl_dynamic() {
  local kind="$1" out
  # The CLI already knows the project from --project or the working directory.
  out="$(${bin} __complete "$kind" \${COMP_WORDS[@]:1} 2>/dev/null)"
  COMPREPLY=( $(compgen -W "$out" -- "$cur") )
}

_${bin}() {
  local cur prev words cword
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"

  case "$prev" in
${dynamicCases}
    --path|--workdir)
      COMPREPLY=( $(compgen -d -- "$cur") )
      return 0
      ;;
    completion)
      COMPREPLY=( $(compgen -W "bash zsh fish" -- "$cur") )
      return 0
      ;;
  esac

  if [[ "$cur" == -* ]]; then
    COMPREPLY=( $(compgen -W "$(${bin} __complete flags \${COMP_WORDS[@]:1} 2>/dev/null)" -- "$cur") )
    return 0
  fi

  if [[ $COMP_CWORD -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "${TOP_LEVEL.join(' ')}" -- "$cur") )
    return 0
  fi

  COMPREPLY=( $(compgen -W "$(${bin} __complete subcommands \${COMP_WORDS[@]:1} 2>/dev/null)" -- "$cur") )
  return 0
}

complete -F _${bin} ${bin}
`;
}

export function zshCompletion(bin: string): string {
  const dynamicCases = Object.entries(DYNAMIC_FLAGS)
    .map(
      ([flag, kind]) =>
        `      ${flag})\n        __agentctl_dynamic ${kind}\n        return\n        ;;`,
    )
    .join('\n');

  return `#compdef ${bin}
# zsh completion for ${bin}
# Install: ${bin} completion zsh > "\${fpath[1]}/_${bin}"   (then: compinit)

__agentctl_dynamic() {
  local kind="$1"
  local -a values
  values=(\${(f)"$(${bin} __complete $kind \${words[2,-1]} 2>/dev/null)"})
  compadd -a values
}

_${bin}() {
  local prev="\${words[CURRENT-1]}"

  case "$prev" in
${dynamicCases}
      --path|--workdir)
        _files -/
        return
        ;;
      completion)
        compadd bash zsh fish
        return
        ;;
  esac

  if [[ "\${words[CURRENT]}" == -* ]]; then
    local -a flags
    flags=(\${(f)"$(${bin} __complete flags \${words[2,-1]} 2>/dev/null)"})
    compadd -a flags
    return
  fi

  if (( CURRENT == 2 )); then
    compadd ${TOP_LEVEL.join(' ')}
    return
  fi

  local -a subs
  subs=(\${(f)"$(${bin} __complete subcommands \${words[2,-1]} 2>/dev/null)"})
  compadd -a subs
}

_${bin} "$@"
`;
}

export function fishCompletion(bin: string): string {
  const lines: string[] = [
    `# fish completion for ${bin}`,
    `# Install: ${bin} completion fish > ~/.config/fish/completions/${bin}.fish`,
    '',
    `function __agentctl_tokens`,
    `    commandline -opc | string collect | string split ' ' | tail -n +2`,
    `end`,
    '',
    `function __agentctl_complete`,
    `    ${bin} __complete $argv[1] (__agentctl_tokens) 2>/dev/null`,
    `end`,
    '',
    `complete -c ${bin} -f`,
  ];

  for (const top of TOP_LEVEL) {
    lines.push(`complete -c ${bin} -n "__fish_use_subcommand" -a "${top}" -d "${describe(top)}"`);
  }

  for (const [group, subs] of Object.entries(COMMAND_TREE)) {
    const parts = group.split(' ');
    const condition =
      parts.length === 1
        ? `__fish_seen_subcommand_from ${parts[0]}`
        : parts.map((p) => `__fish_seen_subcommand_from ${p}`).join('; and ');
    for (const sub of subs) {
      lines.push(`complete -c ${bin} -n "${condition}" -a "${sub}"`);
    }
  }

  for (const [flag, kind] of Object.entries(DYNAMIC_FLAGS)) {
    lines.push(
      `complete -c ${bin} -l ${flag.replace(/^--/, '')} -f -a "(__agentctl_complete ${kind})"`,
    );
  }

  lines.push(
    `complete -c ${bin} -l path -F`,
    `complete -c ${bin} -l workdir -F`,
    `complete -c ${bin} -n "__fish_seen_subcommand_from completion" -a "bash zsh fish"`,
    '',
  );

  return lines.join('\n');
}

function describe(command: string): string {
  const map: Record<string, string> = {
    project: 'Create and select projects',
    session: 'Inspect tmux sessions',
    agent: 'Register and manage agents',
    'agent-worker': 'Run an agent worker process',
    message: 'Send a message between agents',
    task: 'Assign and watch tasks',
    events: 'Read the project event log',
    runner: 'Start and stop runners',
    coordinator: 'Run a coordinator process',
    doctor: 'Diagnose the installation and project state',
    completion: 'Generate shell completion scripts',
    help: 'Show help',
  };
  return map[command] ?? command;
}

export function completionScript(shell: Shell, bin: string): string {
  switch (shell) {
    case 'bash':
      return bashCompletion(bin);
    case 'zsh':
      return zshCompletion(bin);
    case 'fish':
      return fishCompletion(bin);
  }
}

export function installInstructions(shell: Shell, bin: string): string {
  switch (shell) {
    case 'bash':
      return [
        `# System-wide:`,
        `${bin} completion bash | sudo tee /etc/bash_completion.d/${bin} >/dev/null`,
        `# Current user:`,
        `${bin} completion bash > ~/.${bin}-completion.bash`,
        `echo 'source ~/.${bin}-completion.bash' >> ~/.bashrc`,
      ].join('\n');
    case 'zsh':
      return [
        `${bin} completion zsh > "\${fpath[1]}/_${bin}"`,
        `# then reload:`,
        `autoload -Uz compinit && compinit`,
      ].join('\n');
    case 'fish':
      return [
        `mkdir -p ~/.config/fish/completions`,
        `${bin} completion fish > ~/.config/fish/completions/${bin}.fish`,
      ].join('\n');
  }
}
