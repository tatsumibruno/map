import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { type z } from 'zod';

import { AgentctlError, ValidationError } from '../../core/errors.js';

export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

export async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Write via temp file + rename so a reader never observes a partial document.
 * The temp file lives in the destination directory so the rename stays on the
 * same filesystem (rename across devices is not atomic and would EXDEV).
 */
export async function writeFileAtomic(target: string, contents: string): Promise<void> {
  const dir = path.dirname(target);
  await ensureDir(dir);
  const tmp = path.join(dir, `.${path.basename(target)}.${randomBytes(6).toString('hex')}.tmp`);
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(tmp, 'w');
    await handle.writeFile(contents, 'utf8');
    // Durability: the rename is atomic, but the data must hit disk first.
    await handle.sync();
  } finally {
    await handle?.close();
  }
  try {
    await fs.rename(tmp, target);
  } catch (error) {
    await fs.rm(tmp, { force: true });
    throw error;
  }
}

export async function writeJsonAtomic(target: string, value: unknown): Promise<void> {
  await writeFileAtomic(target, `${JSON.stringify(value, null, 2)}\n`);
}

export async function readJsonFile<T>(target: string, schema: z.ZodType<T>): Promise<T> {
  let raw: string;
  try {
    raw = await fs.readFile(target, 'utf8');
  } catch (error) {
    throw new AgentctlError(`Cannot read ${target}`, { code: 'E_IO', cause: error });
  }
  return parseJsonWithSchema(raw, schema, target);
}

export async function readJsonFileIfExists<T>(
  target: string,
  schema: z.ZodType<T>,
): Promise<T | undefined> {
  if (!(await pathExists(target))) return undefined;
  return readJsonFile(target, schema);
}

export function parseJsonWithSchema<T>(raw: string, schema: z.ZodType<T>, source: string): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ValidationError(
      `${source} is not valid JSON`,
      `Fix or delete the file; it is part of the .agentctl state directory. (${String(error)})`,
    );
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new ValidationError(
      `${source} does not match the expected schema`,
      formatZodIssues(result.error),
    );
  }
  return result.data;
}

export function formatZodIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const at = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      return `${at}: ${issue.message}`;
    })
    .join('; ');
}
