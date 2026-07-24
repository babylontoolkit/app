/**
 * Building the server working-copy envelope (SPEC §4.5.4c, §4.16).
 *
 * This is the CPU-heavy half of a working-copy save: base64-encode every binary and assemble the
 * `{ seq, files }` JSON the server stores. It is factored out here, pure and dependency-free, for two
 * reasons:
 *
 *   1. It runs inside a Web Worker (`working-copy.worker.ts`) so the encode + `JSON.stringify` never
 *      pin the main thread — the freeze the §4.16 media crash was (gigabytes of base64 stringified
 *      synchronously while the tab tried to keep streaming). Keeping it pure means the worker file is a
 *      thin message shim and the real logic is testable in node.
 *   2. It is the inline FALLBACK when a worker cannot be constructed, so the exact same bytes are
 *      produced whether or not the worker path is taken.
 *
 * `encodeBase64` prefers `Buffer` (node/test + the Vite polyfill) and falls back to a chunked `btoa`,
 * so the module works in the main thread, a worker, and a test with no branching at the call site.
 */
import type { SerializedFileMap } from '~/lib/binary/binary-files';

/** One file to include in the envelope. Binary carries raw `bytes`; text carries `text`. */
export interface WorkingCopyEntry {
  path: string;
  isBinary: boolean;
  size?: number;
  text?: string;
  bytes?: Uint8Array;
}

/** Uint8Array → base64, working in the main thread, a worker, and node — without node:buffer at runtime. */
function encodeBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }

  let binary = '';

  // 0x8000 keeps String.fromCharCode's argument count within engine limits on large buffers.
  const CHUNK = 0x8000;

  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }

  return btoa(binary);
}

/**
 * Assemble the `SerializedFileMap` from raw entries. Binary bytes become base64; text is verbatim.
 *
 * Secret filtering is the CALLER's job (it happens before bytes are read, so a secret's bytes never
 * enter this function) — mirroring the one-rule-one-place `isSecretPath` used by every other path that
 * ships a user's files anywhere.
 */
export function assembleSerializedMap(entries: WorkingCopyEntry[]): SerializedFileMap {
  const map: SerializedFileMap = {};

  for (const entry of entries) {
    if (entry.isBinary) {
      const bytes = entry.bytes ?? new Uint8Array(0);
      map[entry.path] = {
        type: 'file',
        content: encodeBase64(bytes),
        isBinary: true,
        size: entry.size ?? bytes.byteLength,
      };
    } else {
      map[entry.path] = { type: 'file', content: entry.text ?? '', isBinary: false, size: entry.size };
    }
  }

  return map;
}

/** The exact request body the working-copy route expects: `{ seq, files }`, base64-faithful. */
export function buildWorkingCopyBody(seq: number, entries: WorkingCopyEntry[]): string {
  return JSON.stringify({ seq, files: assembleSerializedMap(entries) });
}
