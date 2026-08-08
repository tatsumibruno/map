import { execa, type ExecaError } from 'execa';

import { TransportError } from '../../core/errors.js';
import { tmuxSessionSchema } from '../../domain/schemas.js';

export interface TmuxSessionInfo {
  name: string;
  windows: number;
  attached: boolean;
  createdAt?: string;
}

export interface TmuxClient {
  isAvailable(): Promise<boolean>;
  version(): Promise<string>;
  listSessions(): Promise<TmuxSessionInfo[]>;
  hasSession(name: string): Promise<boolean>;
  /** Type `text` literally into the session, optionally submitting with Enter. */
  sendText(name: string, text: string, options?: { submit?: boolean }): Promise<void>;
  /** Send tmux key names such as `Escape` or `C-c`. */
  sendKeys(name: string, keys: readonly string[]): Promise<void>;
  /** Capture the last `lines` rows of the active pane. */
  capturePane(name: string, lines?: number): Promise<string>;
  newSession(name: string, options?: { cwd?: string; command?: readonly string[] }): Promise<void>;
  killSession(name: string): Promise<void>;
}

/**
 * Session names come from user input and end up as tmux targets, so they are
 * re-validated here even though `agent register` already checked them. Every
 * call uses argv arrays — never a shell string — so nothing is interpolated.
 */
function assertSessionName(name: string): string {
  const parsed = tmuxSessionSchema.safeParse(name);
  if (!parsed.success) {
    throw new TransportError(`Invalid tmux session name: ${JSON.stringify(name)}`, {
      hint: 'Session names must not contain whitespace, ":", "." or "-" prefixed control sequences.',
    });
  }
  return parsed.data;
}

export class ExecaTmuxClient implements TmuxClient {
  constructor(private readonly binary = process.env['AGENTCTL_TMUX_BIN'] ?? 'tmux') {}

  private async run(args: readonly string[], input?: string) {
    try {
      return await execa(this.binary, [...args], {
        ...(input === undefined ? {} : { input }),
        reject: true,
        stripFinalNewline: false,
      });
    } catch (error) {
      const execaError = error as ExecaError;
      if ((execaError as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new TransportError(`tmux binary "${this.binary}" not found`, {
          hint: 'Install tmux, or point AGENTCTL_TMUX_BIN at the executable.',
          cause: error,
        });
      }
      throw new TransportError(
        `tmux ${args.join(' ')} failed: ${execaError.stderr || execaError.shortMessage || String(error)}`,
        { cause: error },
      );
    }
  }

  async isAvailable(): Promise<boolean> {
    try {
      await execa(this.binary, ['-V']);
      return true;
    } catch {
      return false;
    }
  }

  async version(): Promise<string> {
    const { stdout } = await this.run(['-V']);
    return stdout.trim();
  }

  async listSessions(): Promise<TmuxSessionInfo[]> {
    try {
      const { stdout } = await execa(this.binary, [
        'list-sessions',
        '-F',
        '#{session_name}\t#{session_windows}\t#{session_attached}\t#{session_created}',
      ]);
      return stdout
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '')
        .map((line) => {
          const [name = '', windows = '0', attached = '0', created] = line.split('\t');
          const info: TmuxSessionInfo = {
            name,
            windows: Number.parseInt(windows, 10) || 0,
            attached: attached !== '0',
          };
          const epoch = created ? Number.parseInt(created, 10) : Number.NaN;
          if (!Number.isNaN(epoch)) info.createdAt = new Date(epoch * 1000).toISOString();
          return info;
        });
    } catch (error) {
      const execaError = error as ExecaError;
      // "no server running on ..." simply means zero sessions.
      if (typeof execaError.stderr === 'string' && /no server running/i.test(execaError.stderr)) {
        return [];
      }
      if ((execaError as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new TransportError(`tmux binary "${this.binary}" not found`, {
          hint: 'Install tmux, or point AGENTCTL_TMUX_BIN at the executable.',
          cause: error,
        });
      }
      throw new TransportError(`Cannot list tmux sessions: ${execaError.stderr || String(error)}`, {
        cause: error,
      });
    }
  }

  async hasSession(name: string): Promise<boolean> {
    const session = assertSessionName(name);
    try {
      await execa(this.binary, ['has-session', '-t', `=${session}`]);
      return true;
    } catch {
      return false;
    }
  }

  async sendText(name: string, text: string, options: { submit?: boolean } = {}): Promise<void> {
    const session = assertSessionName(name);
    // `-l` sends the payload literally, so nothing in `text` is interpreted as
    // a key name (`C-c`, `Enter`, ...) or expanded by a shell.
    await this.run(['send-keys', '-t', `=${session}`, '-l', '--', text]);
    if (options.submit !== false) {
      await this.run(['send-keys', '-t', `=${session}`, 'Enter']);
    }
  }

  async sendKeys(name: string, keys: readonly string[]): Promise<void> {
    if (keys.length === 0) return;
    const session = assertSessionName(name);
    await this.run(['send-keys', '-t', `=${session}`, ...keys]);
  }

  async capturePane(name: string, lines = 200): Promise<string> {
    const session = assertSessionName(name);
    const start = `-${Math.max(1, Math.trunc(lines))}`;
    const { stdout } = await this.run([
      'capture-pane',
      '-p',
      '-J',
      '-S',
      start,
      '-t',
      `=${session}`,
    ]);
    return stdout;
  }

  async newSession(
    name: string,
    options: { cwd?: string; command?: readonly string[] } = {},
  ): Promise<void> {
    const session = assertSessionName(name);
    const args = ['new-session', '-d', '-s', session];
    if (options.cwd) args.push('-c', options.cwd);
    if (options.command && options.command.length > 0) args.push('--', ...options.command);
    await this.run(args);
  }

  async killSession(name: string): Promise<void> {
    const session = assertSessionName(name);
    await this.run(['kill-session', '-t', `=${session}`]);
  }
}

export function createTmuxClient(): TmuxClient {
  return new ExecaTmuxClient();
}
