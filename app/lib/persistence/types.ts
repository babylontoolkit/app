import type { SerializedFileMap } from '~/lib/binary/binary-files';

export interface Snapshot {
  chatIndex: string;

  /**
   * Serialized project tree. Binary files carry their bytes as base64 (SPEC §4.4) so a
   * snapshot→restore round-trip is byte-exact. Persisting the raw in-memory FileMap here
   * stored `content: ''` for every binary and restored PNGs/GLBs as 0-byte files.
   */
  files: SerializedFileMap;
  summary?: string;
}
