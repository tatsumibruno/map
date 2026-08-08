import fs from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { readJsonFile, writeFileAtomic, writeJsonAtomic } from '../../src/infra/fs/atomic.js';
import {
  appendJsonl,
  readAllJsonl,
  readJsonlFrom,
  readJsonlLenient,
} from '../../src/infra/fs/jsonl.js';
import { FileLock, withLock } from '../../src/infra/fs/lock.js';
import { isInside } from '../../src/infra/fs/paths.js';
import { makeTempDir } from '../helpers.js';

const record = z.object({ n: z.number(), tag: z.string() });

const dirs: string[] = [];
async function tmp(): Promise<string> {
  const dir = await makeTempDir('agentctl-fs');
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('atomic writes', () => {
  it('creates parent directories and round-trips JSON', async () => {
    const dir = await tmp();
    const target = path.join(dir, 'nested', 'deeper', 'value.json');
    await writeJsonAtomic(target, { n: 1, tag: 'a' });
    expect(await readJsonFile(target, record)).toEqual({ n: 1, tag: 'a' });
  });

  it('leaves no temporary files behind', async () => {
    const dir = await tmp();
    await writeFileAtomic(path.join(dir, 'file.txt'), 'hello');
    expect(await fs.readdir(dir)).toEqual(['file.txt']);
  });

  it('replaces content wholesale rather than appending', async () => {
    const dir = await tmp();
    const target = path.join(dir, 'file.txt');
    await writeFileAtomic(target, 'first-and-longer');
    await writeFileAtomic(target, 'second');
    expect(await fs.readFile(target, 'utf8')).toBe('second');
  });

  it('rejects malformed JSON with a helpful error', async () => {
    const dir = await tmp();
    const target = path.join(dir, 'broken.json');
    await fs.writeFile(target, '{not json', 'utf8');
    await expect(readJsonFile(target, record)).rejects.toThrow(/not valid JSON/);
  });

  it('rejects JSON that does not match the schema', async () => {
    const dir = await tmp();
    const target = path.join(dir, 'wrong.json');
    await fs.writeFile(target, '{"n":"one"}', 'utf8');
    await expect(readJsonFile(target, record)).rejects.toThrow(
      /does not match the expected schema/,
    );
  });
});

describe('jsonl append-only logs', () => {
  it('appends and reads back every record', async () => {
    const dir = await tmp();
    const file = path.join(dir, 'log.jsonl');
    const locks = path.join(dir, 'locks');
    for (let n = 0; n < 5; n += 1) await appendJsonl(file, locks, { n, tag: `t${n}` });
    const entries = await readAllJsonl(file, record);
    expect(entries.map((e) => e.n)).toEqual([0, 1, 2, 3, 4]);
  });

  it('resumes from a byte offset without reprocessing', async () => {
    const dir = await tmp();
    const file = path.join(dir, 'log.jsonl');
    const locks = path.join(dir, 'locks');
    await appendJsonl(file, locks, { n: 1, tag: 'a' });
    const first = await readJsonlFrom(file, record, 0);
    expect(first.entries).toHaveLength(1);

    await appendJsonl(file, locks, { n: 2, tag: 'b' });
    const second = await readJsonlFrom(file, record, first.offset);
    expect(second.entries.map((e) => e.n)).toEqual([2]);

    const third = await readJsonlFrom(file, record, second.offset);
    expect(third.entries).toHaveLength(0);
  });

  it('ignores a trailing partial line until it is complete', async () => {
    const dir = await tmp();
    const file = path.join(dir, 'log.jsonl');
    await fs.writeFile(file, '{"n":1,"tag":"a"}\n{"n":2,"ta', 'utf8');
    const read = await readJsonlFrom(file, record, 0);
    expect(read.entries.map((e) => e.n)).toEqual([1]);

    await fs.appendFile(file, 'g":"b"}\n', 'utf8');
    const rest = await readJsonlFrom(file, record, read.offset);
    expect(rest.entries.map((e) => e.n)).toEqual([2]);
  });

  it('restarts cleanly when the file was truncated', async () => {
    const dir = await tmp();
    const file = path.join(dir, 'log.jsonl');
    await fs.writeFile(file, '{"n":1,"tag":"a"}\n', 'utf8');
    const read = await readJsonlFrom(file, record, 1000);
    expect(read.offset).toBe(0);
  });

  it('rejects malformed lines in strict mode and skips them in lenient mode', async () => {
    const dir = await tmp();
    const file = path.join(dir, 'log.jsonl');
    await fs.writeFile(file, '{"n":1,"tag":"a"}\nnot-json\n{"n":3,"tag":"c"}\n', 'utf8');
    await expect(readAllJsonl(file, record)).rejects.toThrow(/not valid JSON/);

    const lenient = await readJsonlLenient(file, record);
    expect(lenient.entries.map((e) => e.n)).toEqual([1, 3]);
    expect(lenient.invalidLines).toEqual([2]);
  });

  it('keeps concurrent appends intact', async () => {
    const dir = await tmp();
    const file = path.join(dir, 'log.jsonl');
    const locks = path.join(dir, 'locks');
    await Promise.all(
      Array.from({ length: 40 }, (_, n) => appendJsonl(file, locks, { n, tag: 'concurrent' })),
    );
    const entries = await readAllJsonl(file, record);
    expect(entries).toHaveLength(40);
    expect(new Set(entries.map((e) => e.n)).size).toBe(40);
  });
});

describe('file locks', () => {
  it('serialises critical sections', async () => {
    const dir = await tmp();
    const locks = path.join(dir, 'locks');
    let active = 0;
    let maxActive = 0;
    await Promise.all(
      Array.from({ length: 8 }, () =>
        withLock(locks, 'shared', async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          active -= 1;
        }),
      ),
    );
    expect(maxActive).toBe(1);
  });

  it('times out instead of hanging forever', async () => {
    const dir = await tmp();
    const locks = path.join(dir, 'locks');
    const held = await FileLock.acquire(locks, 'busy');
    await expect(
      FileLock.acquire(locks, 'busy', { timeoutMs: 100, staleMs: 60_000 }),
    ).rejects.toThrow(/Timed out/);
    await held.release();
  });

  it('breaks a stale lock', async () => {
    const dir = await tmp();
    const locks = path.join(dir, 'locks');
    const held = await FileLock.acquire(locks, 'abandoned');
    const second = await FileLock.acquire(locks, 'abandoned', { staleMs: 0, timeoutMs: 1000 });
    await second.release();
    await held.release();
  });
});

describe('path containment', () => {
  it('recognises paths inside and outside a root', () => {
    expect(isInside('/a/b', '/a/b')).toBe(true);
    expect(isInside('/a/b', '/a/b/c/d.md')).toBe(true);
    expect(isInside('/a/b', '/a/c')).toBe(false);
    expect(isInside('/a/b', '/a/b/../../etc/passwd')).toBe(false);
  });
});
