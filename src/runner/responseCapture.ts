import fs from 'node:fs/promises';

import { pathExists } from '../infra/fs/atomic.js';
import { RESPONSE_SENTINEL_BEGIN, RESPONSE_SENTINEL_END } from '../providers/envelope.js';

/**
 * Pulls the last complete sentinel-delimited block out of a terminal capture.
 * This is the *fallback* path: the primary channel is the response file, which
 * does not depend on scrollback size or wrapping.
 */
export function extractSentinelBlock(capture: string): string | undefined {
  const end = capture.lastIndexOf(RESPONSE_SENTINEL_END);
  if (end === -1) return undefined;
  const begin = capture.lastIndexOf(RESPONSE_SENTINEL_BEGIN, end);
  if (begin === -1) return undefined;
  const body = capture.slice(begin + RESPONSE_SENTINEL_BEGIN.length, end);
  const trimmed = body.replace(/^[^\n]*\n/, '').trim();
  return trimmed === '' ? undefined : trimmed;
}

export interface FileSnapshot {
  size: number;
  mtimeMs: number;
}

export async function snapshotFile(file: string): Promise<FileSnapshot | undefined> {
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile()) return undefined;
    return { size: stat.size, mtimeMs: stat.mtimeMs };
  } catch {
    return undefined;
  }
}

export function sameSnapshot(a: FileSnapshot | undefined, b: FileSnapshot | undefined): boolean {
  if (!a || !b) return false;
  return a.size === b.size && a.mtimeMs === b.mtimeMs;
}

/**
 * Reads the response file once it has stopped changing. An agent writing a
 * long answer can be observed mid-write, so the caller only calls this after
 * two identical snapshots.
 */
export async function readResponseFile(file: string): Promise<string | undefined> {
  if (!(await pathExists(file))) return undefined;
  const content = (await fs.readFile(file, 'utf8')).trim();
  return content === '' ? undefined : content;
}
