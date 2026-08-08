import fs from 'node:fs/promises';
import path from 'node:path';

import { type z } from 'zod';

import { ValidationError } from '../../core/errors.js';
import { ensureDir, formatZodIssues, pathExists } from './atomic.js';
import { withLock } from './lock.js';

export interface JsonlRead<T> {
  entries: T[];
  /** Byte offset of the end of the last complete line consumed. */
  offset: number;
}

function encodeLine(value: unknown): string {
  const line = JSON.stringify(value);
  if (line.includes('\n')) {
    // JSON.stringify escapes newlines, so this is a safety net, not a hot path.
    throw new ValidationError('Refusing to append a JSONL record containing a raw newline');
  }
  return `${line}\n`;
}

/**
 * Append one record. Serialised through a named lock so two processes sharing
 * a Docker volume cannot interleave partial writes.
 */
export async function appendJsonl(
  file: string,
  locksDir: string,
  value: unknown,
  lockName?: string,
): Promise<void> {
  const line = encodeLine(value);
  await ensureDir(path.dirname(file));
  const name = lockName ?? path.basename(path.dirname(file)) + '-' + path.basename(file);
  await withLock(locksDir, name, async () => {
    const handle = await fs.open(file, 'a');
    try {
      await handle.writeFile(line, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
  });
}

export async function appendJsonlMany(
  file: string,
  locksDir: string,
  values: readonly unknown[],
  lockName?: string,
): Promise<void> {
  if (values.length === 0) return;
  const payload = values.map(encodeLine).join('');
  await ensureDir(path.dirname(file));
  const name = lockName ?? path.basename(path.dirname(file)) + '-' + path.basename(file);
  await withLock(locksDir, name, async () => {
    const handle = await fs.open(file, 'a');
    try {
      await handle.writeFile(payload, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
  });
}

/**
 * Read complete lines starting at `fromOffset`. A trailing partial line (a
 * writer caught mid-append) is left unconsumed and reported via the returned
 * offset, so the next call picks it up once it is complete.
 */
export async function readJsonlFrom<T>(
  file: string,
  schema: z.ZodType<T>,
  fromOffset = 0,
): Promise<JsonlRead<T>> {
  if (!(await pathExists(file))) return { entries: [], offset: fromOffset };

  const handle = await fs.open(file, 'r');
  let buffer: Buffer;
  try {
    const stat = await handle.stat();
    if (stat.size <= fromOffset) {
      // Truncated or replaced underneath us: restart from the top.
      return { entries: [], offset: stat.size < fromOffset ? 0 : fromOffset };
    }
    const length = stat.size - fromOffset;
    buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, fromOffset);
  } finally {
    await handle.close();
  }

  const text = buffer.toString('utf8');
  const lastNewline = text.lastIndexOf('\n');
  if (lastNewline === -1) return { entries: [], offset: fromOffset };

  const complete = text.slice(0, lastNewline + 1);
  const consumed = Buffer.byteLength(complete, 'utf8');
  const entries: T[] = [];

  for (const [index, line] of complete.split('\n').entries()) {
    if (line.trim() === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new ValidationError(
        `${file}:${index + 1} is not valid JSON`,
        'The append-only log is corrupt. Run `agentctl doctor` for details.',
      );
    }
    const result = schema.safeParse(parsed);
    if (!result.success) {
      throw new ValidationError(
        `${file}:${index + 1} does not match the expected schema`,
        formatZodIssues(result.error),
      );
    }
    entries.push(result.data);
  }

  return { entries, offset: fromOffset + consumed };
}

export async function readAllJsonl<T>(file: string, schema: z.ZodType<T>): Promise<T[]> {
  const { entries } = await readJsonlFrom(file, schema, 0);
  return entries;
}

/** Like `readAllJsonl` but skips malformed lines instead of throwing. */
export async function readJsonlLenient<T>(
  file: string,
  schema: z.ZodType<T>,
): Promise<{ entries: T[]; invalidLines: number[] }> {
  if (!(await pathExists(file))) return { entries: [], invalidLines: [] };
  const raw = await fs.readFile(file, 'utf8');
  const entries: T[] = [];
  const invalidLines: number[] = [];
  for (const [index, line] of raw.split('\n').entries()) {
    if (line.trim() === '') continue;
    try {
      const result = schema.safeParse(JSON.parse(line));
      if (result.success) entries.push(result.data);
      else invalidLines.push(index + 1);
    } catch {
      invalidLines.push(index + 1);
    }
  }
  return { entries, invalidLines };
}
