/**
 * Client-side store-asset introspection (SPEC §4.9 — "the GLB unwrap on the client for store-asset
 * introspection").
 *
 * Uploaded assets are introspected on the SERVER (the bytes are already there). Store-catalog assets are
 * hosted URLs the server never fetches, so their component reference has to be produced HERE, in the
 * browser, when a user adds one — otherwise the agent only sees the static `components` list from the
 * catalog config, not the asset's real tuned components.
 *
 * The unwrap dispatches on container format:
 *   - `.glb`            → binary GLB, JSON chunk extracted with `glbToJson`
 *   - `.gltf`           → plain-text glTF JSON
 *   - `.gz.gltf` / gzip → gzip-compressed glTF text, inflated with the browser's DecompressionStream
 *
 * Then it runs the SAME pure introspection the server uses (`introspectGltf` / `renderComponentReference`),
 * so a store prefab and an uploaded prefab produce an identical component reference for the agent.
 *
 * Best-effort and tolerant: a malformed or unreachable asset returns an empty result, never throws — a
 * store add must not fail because the model could not be introspected.
 */
import { glbToJson, looksLikeGlb } from './glb';
import { introspectGltf, renderComponentReference } from './introspect';

export interface StoreAssetIntrospection {
  /** The markdown component reference for the agent context, or null if the asset carries none. */
  reference: string | null;

  /** Distinct component classes discovered — for a quick UI read ("StandardCarController · …"). */
  classes: string[];
}

const EMPTY: StoreAssetIntrospection = { reference: null, classes: [] };

/** True when bytes begin with the gzip magic (0x1f 0x8b). */
function looksGzipped(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  // DecompressionStream is available in every browser we target; guard for SSR/older runtimes.
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('gzip decompression is not available in this environment');
  }

  const stream = new Response(bytes).body!.pipeThrough(new DecompressionStream('gzip'));
  const inflated = await new Response(stream).arrayBuffer();

  return new Uint8Array(inflated);
}

/** Parse fetched bytes into glTF JSON, dispatching on container format. */
async function unwrapToGltf(bytes: Uint8Array): Promise<unknown> {
  if (looksLikeGlb(bytes)) {
    return glbToJson(bytes);
  }

  const raw = looksGzipped(bytes) ? await gunzip(bytes) : bytes;

  return JSON.parse(new TextDecoder().decode(raw));
}

/**
 * Fetch a hosted store asset and produce its component reference, in the browser.
 *
 * `url` is a public asset URL from the catalog (e.g. a prefab `.glb` or a scene `.gz.gltf`). Returns an
 * empty result on any failure — introspection is an enhancement, not a gate.
 */
export async function introspectStoreAssetUrl(url: string): Promise<StoreAssetIntrospection> {
  try {
    if (typeof fetch !== 'function') {
      return EMPTY;
    }

    const response = await fetch(url);

    if (!response.ok) {
      return EMPTY;
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    const gltf = await unwrapToGltf(bytes);
    const introspection = introspectGltf(gltf);

    return {
      reference: renderComponentReference(assetNameFromUrl(url), introspection),
      classes: introspection.classes,
    };
  } catch {
    return EMPTY;
  }
}

/** A readable asset name from its URL, for the reference heading. */
function assetNameFromUrl(url: string): string {
  try {
    const path = new URL(url, 'https://x').pathname;
    return path.split('/').pop() || url;
  } catch {
    return url;
  }
}
