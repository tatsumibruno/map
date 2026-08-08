import fs from 'node:fs/promises';
import path from 'node:path';

import { ConflictError } from '../../core/errors.js';
import { sleep } from '../../core/time.js';

export interface LockOptions {
  /** Give up after this long waiting for the holder to release. */
  timeoutMs?: number;
  /** Consider an existing lock abandoned after this long. */
  staleMs?: number;
  pollMs?: number;
}

const DEFAULTS = { timeoutMs: 10_000, staleMs: 30_000, pollMs: 25 };

interface LockMeta {
  pid: number;
  acquiredAt: string;
  host: string;
}

/**
 * Cross-process mutex built on `mkdir`, which is atomic on POSIX and on the
 * bind/volume mounts used by Docker. Advisory only: every writer must take the
 * lock for it to mean anything.
 */
export class FileLock {
  private constructor(
    private readonly dir: string,
    private released = false,
  ) {}

  static async acquire(
    locksDir: string,
    name: string,
    options: LockOptions = {},
  ): Promise<FileLock> {
    const { timeoutMs, staleMs, pollMs } = { ...DEFAULTS, ...options };
    await fs.mkdir(locksDir, { recursive: true });
    const dir = path.join(locksDir, `${name}.lock`);
    const deadline = Date.now() + timeoutMs;

    for (;;) {
      try {
        await fs.mkdir(dir);
        const meta: LockMeta = {
          pid: process.pid,
          acquiredAt: new Date().toISOString(),
          host: process.env['HOSTNAME'] ?? 'unknown',
        };
        await fs.writeFile(path.join(dir, 'meta.json'), JSON.stringify(meta), 'utf8');
        return new FileLock(dir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (await FileLock.isStale(dir, staleMs)) {
          await fs.rm(dir, { recursive: true, force: true });
          continue;
        }
        if (Date.now() >= deadline) {
          throw new ConflictError(
            `Timed out after ${timeoutMs}ms waiting for lock "${name}"`,
            `Another agentctl process may be stuck. Inspect ${dir} and remove it if the owning process is gone.`,
          );
        }
        await sleep(pollMs);
      }
    }
  }

  private static async isStale(dir: string, staleMs: number): Promise<boolean> {
    try {
      const stat = await fs.stat(dir);
      return Date.now() - stat.mtimeMs > staleMs;
    } catch {
      // Disappeared while we looked: treat as free, the next mkdir decides.
      return false;
    }
  }

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    await fs.rm(this.dir, { recursive: true, force: true });
  }
}

export async function withLock<T>(
  locksDir: string,
  name: string,
  fn: () => Promise<T>,
  options?: LockOptions,
): Promise<T> {
  const lock = await FileLock.acquire(locksDir, name, options);
  try {
    return await fn();
  } finally {
    await lock.release();
  }
}
