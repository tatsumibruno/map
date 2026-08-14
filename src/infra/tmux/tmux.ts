import { execa, type ExecaError } from 'execa';

import { TransportError } from '../../core/errors.js';
import { tmuxSessionSchema } from '../../domain/schemas.js';

export interface TmuxSessionInfo {
  name: string;
  windows: number;
  attached: boolean;
  createdAt?: string;
}

/** One pane, as reported by `list-panes`/`display-message`. */
export interface TmuxPaneInfo {
  paneId: string;
  sessionName: string;
  windowIndex: number;
  paneIndex: number;
  windowName?: string | undefined;
  dead: boolean;
}

export interface TmuxClient {
  isAvailable(): Promise<boolean>;
  version(): Promise<string>;
  listSessions(): Promise<TmuxSessionInfo[]>;
  hasSession(name: string): Promise<boolean>;
  /** Every pane on the server, across every session and window. */
  listPanes(): Promise<TmuxPaneInfo[]>;
  /**
   * Resolves a single target — a pane id (`%7`), a qualified target
   * (`=session:0.0`), or a bare session name — to live pane info. Returns
   * `undefined` (never throws) when the target does not address a pane, which
   * notably includes a bare `=session` target: tmux accepts it for
   * `has-session`/`display-message` but does not resolve it to a pane.
   */
  paneInfo(target: string): Promise<TmuxPaneInfo | undefined>;
  /**
   * Type `text` literally into `target`, optionally submitting with Enter.
   * Fine for short, single-line control text; long or multi-line payloads
   * should go through `setBuffer`/`pasteBuffer` instead (see `deliverToPane`
   * in `runner/dispatch.ts`), since some TUIs debounce fast literal typing.
   */
  sendText(target: string, text: string, options?: { submit?: boolean }): Promise<void>;
  /** Send tmux key names such as `Escape` or `C-m` to `target`. */
  sendKeys(target: string, keys: readonly string[]): Promise<void>;
  /** Loads `text` into the tmux paste buffer verbatim (no key interpretation). */
  setBuffer(text: string): Promise<void>;
  /** Pastes the most recent buffer into `target`. Consumes it by default. */
  pasteBuffer(target: string, options?: { delete?: boolean }): Promise<void>;
  /** Capture the last `lines` rows of `target`. */
  capturePane(target: string, lines?: number): Promise<string>;
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

/**
 * Pane targets are produced by our own resolution code (a pane id, a
 * qualified `=session:window.pane`, or a plain session name), never typed by
 * a user, so this is a sanity check rather than a security boundary — argv
 * execution is what actually prevents injection.
 */
const PANE_TARGET_PATTERN = /^(%\d+|=?[A-Za-z0-9][A-Za-z0-9_@%+=,.:-]*)$/;

function assertPaneTarget(target: string): string {
  if (target.length === 0 || target.length > 256 || !PANE_TARGET_PATTERN.test(target)) {
    throw new TransportError(`Invalid tmux pane target: ${JSON.stringify(target)}`, {
      hint: 'Expected a pane id like "%7", a qualified target like "=session:0.0", or a session name.',
    });
  }
  return target;
}

const PANE_FORMAT =
  '#{pane_id}\t#{session_name}\t#{window_index}\t#{pane_index}\t#{window_name}\t#{pane_dead}';

function parsePaneLine(raw: string): TmuxPaneInfo | undefined {
  const line = raw.trim();
  if (!line) return undefined;
  const [paneId, sessionName, windowIndexRaw, paneIndexRaw, windowName, deadRaw] = line.split('\t');
  if (!paneId || !sessionName || windowIndexRaw === undefined || paneIndexRaw === undefined) {
    return undefined;
  }
  const windowIndex = Number.parseInt(windowIndexRaw, 10);
  const paneIndex = Number.parseInt(paneIndexRaw, 10);
  if (Number.isNaN(windowIndex) || Number.isNaN(paneIndex)) return undefined;
  return {
    paneId,
    sessionName,
    windowIndex,
    paneIndex,
    windowName: windowName || undefined,
    dead: deadRaw === '1',
  };
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

  async listPanes(): Promise<TmuxPaneInfo[]> {
    try {
      const { stdout } = await execa(this.binary, ['list-panes', '-a', '-F', PANE_FORMAT]);
      return stdout
        .split('\n')
        .map((line) => parsePaneLine(line))
        .filter((p): p is TmuxPaneInfo => p !== undefined);
    } catch (error) {
      const execaError = error as ExecaError;
      // "no server running on ..." simply means zero panes.
      if (typeof execaError.stderr === 'string' && /no server running/i.test(execaError.stderr)) {
        return [];
      }
      if ((execaError as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new TransportError(`tmux binary "${this.binary}" not found`, {
          hint: 'Install tmux, or point AGENTCTL_TMUX_BIN at the executable.',
          cause: error,
        });
      }
      throw new TransportError(`Cannot list tmux panes: ${execaError.stderr || String(error)}`, {
        cause: error,
      });
    }
  }

  async paneInfo(target: string): Promise<TmuxPaneInfo | undefined> {
    const t = assertPaneTarget(target);
    try {
      const { stdout } = await execa(this.binary, ['display-message', '-p', '-t', t, PANE_FORMAT]);
      return parsePaneLine(stdout);
    } catch {
      return undefined;
    }
  }

  async sendText(target: string, text: string, options: { submit?: boolean } = {}): Promise<void> {
    const t = assertPaneTarget(target);
    // `-l` sends the payload literally, so nothing in `text` is interpreted as
    // a key name (`C-c`, `Enter`, ...) or expanded by a shell.
    await this.run(['send-keys', '-t', t, '-l', '--', text]);
    if (options.submit !== false) {
      await this.run(['send-keys', '-t', t, 'Enter']);
    }
  }

  async sendKeys(target: string, keys: readonly string[]): Promise<void> {
    if (keys.length === 0) return;
    const t = assertPaneTarget(target);
    await this.run(['send-keys', '-t', t, ...keys]);
  }

  async setBuffer(text: string): Promise<void> {
    await this.run(['set-buffer', '--', text]);
  }

  async pasteBuffer(target: string, options: { delete?: boolean } = {}): Promise<void> {
    const t = assertPaneTarget(target);
    const args = ['paste-buffer', '-t', t];
    if (options.delete !== false) args.push('-d');
    await this.run(args);
  }

  async capturePane(target: string, lines = 200): Promise<string> {
    const t = assertPaneTarget(target);
    const start = `-${Math.max(1, Math.trunc(lines))}`;
    const { stdout } = await this.run(['capture-pane', '-p', '-J', '-S', start, '-t', t]);
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
