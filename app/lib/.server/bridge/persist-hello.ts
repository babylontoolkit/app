/**
 * Whether a poll's `hello` must be written to the device row (SPEC §4.17, D6).
 *
 * The store is written only when the helper's capabilities CHANGED or `BRIDGE_LAST_SEEN_WRITE_MS` has
 * passed since the last write — never on every poll. "Changed" is a comparison of CONTENT, not bytes:
 * Postgres `jsonb` re-orders object keys, so a raw `JSON.stringify` comparison against a stored row would
 * report a change on every poll and write the store every ≤25 s per device. Hence a key-sorted canonical
 * form (recursive; arrays keep their order, since order is meaningful there).
 */
import { BRIDGE_LAST_SEEN_WRITE_MS, type BridgeHello } from '~/lib/bridge/protocol';

/** JSON with object keys sorted at every depth; arrays keep their order; `undefined` members dropped. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => (item === undefined ? 'null' : canonicalJson(item))).join(',')}]`;
  }

  const record = value as Record<string, unknown>;
  const members = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);

  return `{${members.join(',')}}`;
}

/**
 * @param lastWriteMs the stored `lastSeenAt` as epoch ms, or 0/NaN when never written.
 */
export function shouldPersistHello(
  stored: BridgeHello | undefined,
  hello: BridgeHello,
  lastWriteMs: number,
  now: number,
): boolean {
  if (canonicalJson(stored ?? null) !== canonicalJson(hello)) {
    return true;
  }

  return !(Number.isFinite(lastWriteMs) && lastWriteMs > 0 && now - lastWriteMs < BRIDGE_LAST_SEEN_WRITE_MS);
}
