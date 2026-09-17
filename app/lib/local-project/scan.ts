/**
 * A folder on disk → the `SerializedFileMap` every restore door already speaks (SPEC §4.5.4d). Pure.
 *
 * Keys are SANDBOX-ABSOLUTE (`/home/project/src/main.ts`), the same spelling `serializeFiles` produces,
 * so a disk mount can be handed to `restoreFiles` AND written as a local checkpoint without a second
 * key convention appearing (`toSandboxStoreKey`'s lesson: two spellings of one path is two files).
 */
import { bytesToBase64, fileEntryFromBuffer, type SerializedFileMap } from '~/lib/binary/binary-files';
import type { DiskTree } from './fsa-store';

export function treeToSerializedFileMap(tree: DiskTree, workdir: string): SerializedFileMap {
  const map: SerializedFileMap = {};

  for (const dir of tree.directories) {
    map[`${workdir}/${dir}`] = { type: 'folder' };
  }

  for (const [rel, bytes] of Object.entries(tree.files)) {
    const entry = fileEntryFromBuffer(bytes);

    map[`${workdir}/${rel}`] = entry.isBinary ? { ...entry, content: bytesToBase64(bytes) } : entry;
  }

  return map;
}

/** Byte equality without allocating — the compare-before-write check runs on every mount event. */
export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) {
    return false;
  }

  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }

  return true;
}
