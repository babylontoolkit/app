/**
 * Binary-file support (SPEC §1.3 principle 10, §4.4).
 *
 * Games are binary-heavy (PNG/JPG textures, GLB/GLTF models, audio, fonts, wasm).
 * Upstream bolt.diy's file layer is text-oriented: the WebContainer watcher decodes
 * every file as UTF-8 and stores `content: ''` for anything that fails, so binary
 * bytes are destroyed at ingest and every downstream path (snapshot, restore, ZIP,
 * GitHub sync, share build) inherits an empty string.
 *
 * The rules this module exists to enforce:
 *
 *   1. Binary BYTES survive every round-trip, losslessly.
 *   2. Binary CONTENT never enters LLM context or the editor's text map — the FileMap
 *      carries `isBinary` + `size` only.
 *
 * Those two rules are only reconcilable if the bytes live somewhere other than the
 * FileMap. That place is the WebContainer filesystem, which is the source of truth for
 * binary bytes for the entire session. The FileMap holds metadata; egress paths read
 * real bytes back on demand via `serializeFileMap`; ingress paths write real bytes in
 * via `writeSerializedFileMap` / `fs.writeFile(path, Uint8Array)`.
 *
 * This module is additive (§2.1a): it is hooked into upstream's existing seams rather
 * than restructuring FilesStore's types or flow.
 */
import { getEncoding } from 'istextorbinary';
import { Buffer } from 'node:buffer';
import type { FileMap } from '~/lib/stores/files';

/**
 * The subset of WebContainer's FileSystemAPI this module needs. Declared structurally
 * so the binary layer stays testable and stays swappable for a server-container
 * provider (SPEC §1.3.5, §8) — no WebContainer-specific coupling leaks in here.
 */
export interface BinaryFs {
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: string | Uint8Array): Promise<void>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
}

/**
 * A FileMap flattened for transport (snapshots, S3 tars, share builds).
 *
 * Binary entries carry their bytes as base64 in `content`. This is the ONLY
 * representation in which binary content is allowed to sit in a `content` field —
 * it is a wire format, never the live store, and never reaches the model.
 */
export type SerializedDirent = { type: 'file'; content: string; isBinary: boolean; size?: number } | { type: 'folder' };

export type SerializedFileMap = Record<string, SerializedDirent | undefined>;

/**
 * File extensions that are always treated as binary.
 *
 * Used where we have a path but not (yet) the bytes — e.g. deciding how to decode a
 * template zip entry. Game projects are dominated by these: textures, models, audio,
 * fonts, and the Havok wasm module.
 */
export const BINARY_EXTENSIONS = new Set([
  // images
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'avif',
  'bmp',
  'ico',
  'icns',
  'tif',
  'tiff',
  'tga',
  'psd',
  'dds',
  'ktx',
  'ktx2',
  'basis',
  'exr',
  'hdr',

  // 3D models / scenes
  'glb',
  'gltf',
  'bin',
  'fbx',
  'obj',
  'babylon',
  'babylonbinarymeshdata',
  'incremental',
  'draco',
  'ply',
  'stl',
  'usdz',

  // audio / video
  'mp3',
  'wav',
  'ogg',
  'oga',
  'm4a',
  'aac',
  'flac',
  'mp4',
  'webm',
  'mov',
  'avi',
  'mkv',

  // fonts
  'ttf',
  'otf',
  'woff',
  'woff2',
  'eot',

  // archives / binaries / compressed assets
  'wasm',
  'zip',
  'gz',
  'br',
  'tar',
  '7z',
  'rar',
  'pdf',
  'bz2',
  'xz',
  'node',
  'dll',
  'so',
  'dylib',
  'exe',
  'bin7',
]);

export function isBinaryPath(filePath: string): boolean {
  const name = filePath.split('/').pop() ?? '';
  const parts = name.split('.');

  if (parts.length < 2) {
    return false;
  }

  const ext = parts.pop()!.toLowerCase();

  /*
   * Pre-compressed web assets keep their real type behind the .gz (e.g. scene.gz.gltf is
   * handled above; scene.gltf.gz lands here) — either way they are bytes, not text.
   */
  return BINARY_EXTENSIONS.has(ext);
}

/**
 * Wire format for a file being published to a static host (Netlify/Vercel/GitHub Pages,
 * and our own `/play` share builds). Binaries cross the network base64-encoded and are
 * decoded back to bytes server-side — never sent as a string, which UTF-8 encodes.
 */
export interface DeployFile {
  content: string;
  encoding: 'utf8' | 'base64';
}

/** Decode a wire-format deploy file back into the exact bytes that were on disk. */
export function deployFileToBytes(file: DeployFile | string): Uint8Array {
  if (typeof file === 'string') {
    // Tolerate the legacy text-only shape.
    return new TextEncoder().encode(file);
  }

  return file.encoding === 'base64' ? base64ToBytes(file.content) : new TextEncoder().encode(file.content);
}

export function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

export function base64ToBytes(base64: string): Uint8Array {
  return new Uint8Array(Buffer.from(base64, 'base64'));
}

/**
 * Best-effort binary sniff, matching upstream's heuristic (istextorbinary) so that a
 * file classified as binary here is classified the same way by the editor.
 */
export function isBinaryBuffer(buffer: Uint8Array | undefined): boolean {
  if (buffer === undefined) {
    return false;
  }

  const view = Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength);

  return getEncoding(view, { chunkLength: 100 }) === 'binary';
}

const utf8TextDecoder = new TextDecoder('utf8', { fatal: true });

/**
 * Build the FileMap entry for a file the watcher just saw.
 *
 * For binaries we deliberately keep `content: ''` — the bytes stay on disk in the
 * WebContainer and are read back at egress. We record `size` so the UI and the agent
 * can reason about the file ("public/babylon.png, 12.4 KB") without ever loading it.
 */
export function fileEntryFromBuffer(buffer: Uint8Array | undefined): {
  type: 'file';
  content: string;
  isBinary: boolean;
  size: number;
} {
  const size = buffer?.byteLength ?? 0;
  const isBinary = isBinaryBuffer(buffer);

  if (isBinary) {
    return { type: 'file', content: '', isBinary: true, size };
  }

  let content = '';

  if (buffer && buffer.byteLength > 0) {
    try {
      content = utf8TextDecoder.decode(buffer);
    } catch {
      /*
       * A file that sniffs as text but fails a strict UTF-8 decode (e.g. latin-1) is
       * treated as binary rather than silently emptied, so its bytes still survive.
       */
      return { type: 'file', content: '', isBinary: true, size };
    }
  }

  return { type: 'file', content, isBinary: false, size };
}

/**
 * Snapshot a FileMap for transport, reading real bytes for every binary file from the
 * filesystem. `toRelativePath` maps a store key (absolute, WORK_DIR-prefixed) to the
 * path the fs expects.
 *
 * A file whose bytes cannot be read is reported via `onError` and OMITTED rather than
 * emitted with empty content — a missing file is recoverable, a silently-zeroed PNG is
 * the bug we are fixing.
 */
export async function serializeFileMap(
  files: FileMap,
  fs: BinaryFs,
  toRelativePath: (path: string) => string,
  onError?: (path: string, error: unknown) => void,
): Promise<SerializedFileMap> {
  const serialized: SerializedFileMap = {};

  for (const [filePath, dirent] of Object.entries(files)) {
    if (!dirent) {
      continue;
    }

    if (dirent.type === 'folder') {
      serialized[filePath] = { type: 'folder' };
      continue;
    }

    if (!dirent.isBinary) {
      serialized[filePath] = {
        type: 'file',
        content: dirent.content,
        isBinary: false,
        size: dirent.size,
      };
      continue;
    }

    try {
      const bytes = await fs.readFile(toRelativePath(filePath));
      serialized[filePath] = {
        type: 'file',
        content: bytesToBase64(bytes),
        isBinary: true,
        size: bytes.byteLength,
      };
    } catch (error) {
      onError?.(filePath, error);
    }
  }

  return serialized;
}

/**
 * Materialize a serialized FileMap onto the filesystem, byte-faithfully.
 *
 * Binary entries are base64-decoded and written as `Uint8Array` — never handed to
 * `writeFile` as a string, which would UTF-8 re-encode them and corrupt every byte
 * above 0x7F.
 */
export async function writeSerializedFileMap(
  files: SerializedFileMap,
  fs: BinaryFs,
  toRelativePath: (path: string) => string,
): Promise<void> {
  const entries = Object.entries(files);

  for (const [filePath, dirent] of entries) {
    if (dirent?.type === 'folder') {
      await fs.mkdir(toRelativePath(filePath), { recursive: true });
    }
  }

  for (const [filePath, dirent] of entries) {
    if (dirent?.type !== 'file') {
      continue;
    }

    const relativePath = toRelativePath(filePath);
    const dir = relativePath.split('/').slice(0, -1).join('/');

    if (dir) {
      await fs.mkdir(dir, { recursive: true });
    }

    if (dirent.isBinary) {
      await fs.writeFile(relativePath, base64ToBytes(dirent.content));
    } else {
      await fs.writeFile(relativePath, dirent.content);
    }
  }
}
