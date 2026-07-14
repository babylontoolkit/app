/**
 * User asset upload validation (SPEC §4.9, §5).
 *
 * Real game builders bring their own models, so users can upload GLTF/GLB/textures/audio. Everything
 * that arrives is validated SERVER-SIDE and the result is stored, never executed (§5). This is the
 * pure decision layer: given a filename, byte length, the bytes, and the user's current usage, may we
 * store it — and if so, as what KIND?
 *
 * Three gates, in cost order (cheapest first, so we reject a 2GB upload on its size before we ever look
 * at its bytes):
 *
 * 1. **Type allow-list.** Extension AND a content sniff must agree on a known asset type. An
 *    allow-list, not a deny-list: an unknown type is refused, because "everything except the bad ones"
 *    is one new file format away from a hole.
 * 2. **Size caps.** Per-file and per-user quota (config). An unbounded upload is unbounded S3 spend on
 *    our bill, the storage analogue of the vision-token cap (§4.2.8).
 * 3. **Structural validation** for the formats we can cheaply check (GLB), so a `.glb` that is really
 *    something else is rejected rather than stored as a model the agent will trust (§4.9 introspection).
 */
import { looksLikeGlb } from './glb';

export type AssetKind = 'model' | 'texture' | 'audio' | 'scene' | 'other';

export interface AssetLimits {
  /** Largest single upload, bytes. */
  maxFileBytes: number;

  /** Total storage per user, bytes — the quota (§4.9). */
  maxUserBytes: number;
}

/** Config defaults. Overridable via env at the route (never hardcoded policy — CLAUDE.md conventions). */
export const DEFAULT_ASSET_LIMITS: AssetLimits = {
  maxFileBytes: 50 * 1024 * 1024, // 50 MB — a large character model with 4K textures
  maxUserBytes: 500 * 1024 * 1024, // 500 MB per user (larger for Pro tiers, set at the route)
};

interface AllowedType {
  kind: AssetKind;

  /** Magic-byte sniff, when the format has one. Null = trust the extension (text/loose formats). */
  sniff: ((bytes: Uint8Array) => boolean) | null;
}

/** Extension → kind + optional content sniff. The allow-list; anything not here is refused. */
const ALLOWED: Record<string, AllowedType> = {
  glb: { kind: 'model', sniff: looksLikeGlb },
  gltf: { kind: 'model', sniff: null }, // JSON glTF — structural check happens in introspection
  png: { kind: 'texture', sniff: (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47]) },
  jpg: { kind: 'texture', sniff: (b) => startsWith(b, [0xff, 0xd8, 0xff]) },
  jpeg: { kind: 'texture', sniff: (b) => startsWith(b, [0xff, 0xd8, 0xff]) },
  webp: { kind: 'texture', sniff: (b) => startsWith(b, [0x52, 0x49, 0x46, 0x46]) },
  ktx2: { kind: 'texture', sniff: (b) => startsWith(b, [0xab, 0x4b, 0x54, 0x58]) },
  mp3: { kind: 'audio', sniff: null },
  ogg: { kind: 'audio', sniff: (b) => startsWith(b, [0x4f, 0x67, 0x67, 0x53]) },
  wav: { kind: 'audio', sniff: (b) => startsWith(b, [0x52, 0x49, 0x46, 0x46]) },
  m4a: { kind: 'audio', sniff: null },
};

function startsWith(bytes: Uint8Array, prefix: number[]): boolean {
  if (bytes.byteLength < prefix.length) {
    return false;
  }

  return prefix.every((byte, i) => bytes[i] === byte);
}

export interface AssetUpload {
  filename: string;
  bytes: Uint8Array;

  /** How many bytes this user already stores — for the quota gate. */
  currentUserBytes: number;
}

export type ValidationResult =
  | { ok: true; kind: AssetKind; extension: string }
  | { ok: false; code: 'type' | 'file-too-large' | 'quota' | 'structure' | 'empty'; message: string };

export function validateAssetUpload(upload: AssetUpload, limits: AssetLimits = DEFAULT_ASSET_LIMITS): ValidationResult {
  const { filename, bytes } = upload;

  if (bytes.byteLength === 0) {
    return { ok: false, code: 'empty', message: 'That file is empty.' };
  }

  const extension = filename.split('.').pop()?.toLowerCase() ?? '';
  const allowed = ALLOWED[extension];

  if (!allowed) {
    return {
      ok: false,
      code: 'type',
      message: `${extension ? `.${extension}` : 'That'} files are not supported. Upload a model (.glb/.gltf), texture (.png/.jpg/.webp/.ktx2), or audio (.mp3/.ogg/.wav).`,
    };
  }

  // Size before bytes-inspection — reject the giant upload cheaply.
  if (bytes.byteLength > limits.maxFileBytes) {
    return {
      ok: false,
      code: 'file-too-large',
      message: `That file is ${mb(bytes.byteLength)} MB. The limit is ${mb(limits.maxFileBytes)} MB per file.`,
    };
  }

  if (upload.currentUserBytes + bytes.byteLength > limits.maxUserBytes) {
    return {
      ok: false,
      code: 'quota',
      message: `This would exceed your ${mb(limits.maxUserBytes)} MB asset storage. Remove some assets and try again.`,
    };
  }

  // The content must agree with the extension. A `.png` whose bytes are not a PNG is refused.
  if (allowed.sniff && !allowed.sniff(bytes)) {
    return {
      ok: false,
      code: 'structure',
      message: `That file does not look like a valid .${extension} — its contents do not match its type.`,
    };
  }

  return { ok: true, kind: allowed.kind, extension };
}

function mb(bytes: number): number {
  return Math.round((bytes / (1024 * 1024)) * 10) / 10;
}
