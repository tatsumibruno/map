import { randomBytes } from 'node:crypto';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

function randomSuffix(length: number): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += ALPHABET[bytes[i]! % ALPHABET.length];
  }
  return out;
}

/**
 * Ids are prefixed and sortable-ish: a base36 millisecond timestamp keeps
 * lexicographic order roughly chronological, the random tail avoids
 * collisions between concurrent processes sharing a volume.
 */
function makeId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${randomSuffix(6)}`;
}

export const newProjectId = (): string => makeId('proj');
export const newMessageId = (): string => makeId('msg');
export const newTaskId = (): string => makeId('task');
export const newEventId = (): string => makeId('evt');
