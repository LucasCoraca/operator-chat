import { randomBytes } from 'crypto';
import { z } from 'zod';

// Direct port of opencode's `id/id.ts`, reshaped to idiomatic TS (no Effect schemas).
// ULID-style monotonic IDs with a prefix; ascending IDs sort by creation order,
// descending IDs sort newest-first. The compaction algorithm relies on lexical
// ordering matching temporal ordering, so the format is load-bearing.

const PREFIXES = {
  session: 'ses',
  message: 'msg',
  part: 'prt',
  permission: 'per',
  event: 'evt',
} as const;

export type Prefix = keyof typeof PREFIXES;

const LENGTH = 26;

let lastTimestamp = 0;
let counter = 0;

function randomBase62(length: number): string {
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  let result = '';
  const bytes = randomBytes(length);
  for (let i = 0; i < length; i++) {
    result += chars[bytes[i] % 62];
  }
  return result;
}

function create(prefix: string, direction: 'ascending' | 'descending', timestamp?: number): string {
  const currentTimestamp = timestamp ?? Date.now();

  if (currentTimestamp !== lastTimestamp) {
    lastTimestamp = currentTimestamp;
    counter = 0;
  }
  counter++;

  let now = BigInt(currentTimestamp) * BigInt(0x1000) + BigInt(counter);
  if (direction === 'descending') now = ~now;

  const timeBytes = Buffer.alloc(6);
  for (let i = 0; i < 6; i++) {
    timeBytes[i] = Number((now >> BigInt(40 - 8 * i)) & BigInt(0xff));
  }

  return `${prefix}_${timeBytes.toString('hex')}${randomBase62(LENGTH - 12)}`;
}

function ensure(prefix: Prefix, given?: string): string {
  if (!given) {
    throw new Error('ID is required');
  }
  if (!given.startsWith(PREFIXES[prefix])) {
    throw new Error(`ID ${given} does not start with ${PREFIXES[prefix]}`);
  }
  return given;
}

// Plain string aliases — branding via TS-only symbols proved more friction than
// value when crossing zod's inference boundary. Validation lives in `.zod`.

export type SessionID = string;
export type MessageID = string;
export type PartID = string;

export const SessionID = {
  zod: z.string().startsWith(PREFIXES.session),
  descending: (given?: string): SessionID =>
    given ? ensure('session', given) : create(PREFIXES.session, 'descending'),
  isValid: (s: string): boolean => s.startsWith(`${PREFIXES.session}_`),
};

export const MessageID = {
  zod: z.string().startsWith(PREFIXES.message),
  ascending: (given?: string): MessageID =>
    given ? ensure('message', given) : create(PREFIXES.message, 'ascending'),
  isValid: (s: string): boolean => s.startsWith(`${PREFIXES.message}_`),
};

export const PartID = {
  zod: z.string().startsWith(PREFIXES.part),
  ascending: (given?: string): PartID =>
    given ? ensure('part', given) : create(PREFIXES.part, 'ascending'),
  isValid: (s: string): boolean => s.startsWith(`${PREFIXES.part}_`),
};

/** Extract the timestamp embedded in an ascending ID. Does not work for descending IDs. */
export function timestampOf(id: string): number {
  const prefix = id.split('_')[0];
  const hex = id.slice(prefix.length + 1, prefix.length + 13);
  const encoded = BigInt(`0x${hex}`);
  return Number(encoded / BigInt(0x1000));
}
