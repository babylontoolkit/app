/**
 * Store-asset component references for the agent context (SPEC §4.9).
 *
 * When a user adds a premium/free store asset, the client introspects its GLB (`introspectStoreAssetUrl`)
 * and, if it carries Toolkit components, drops the resulting component reference here. Chat reads this
 * atom into the `/api/agent` body's `assetNotes`, so the agent writes logic against the asset's REAL
 * components — the same reference an uploaded asset produces server-side, just discovered in the browser
 * because the server never fetches a hosted store URL.
 *
 * De-duplicated and bounded: a reference is keyed by its heading line so re-adding the same asset does
 * not stack duplicates, and the list is capped so it can never grow into a context-budget problem (§4.2.8).
 */
import { atom } from 'nanostores';

/** Cap the notes so an over-eager add loop can never bloat the generation context (§4.2.8). */
const MAX_NOTES = 12;

export const assetNotesAtom = atom<string[]>([]);

/** The first line of a component reference (`# Asset Component Reference: car.glb`) — its identity. */
function headingOf(reference: string): string {
  return reference.split('\n', 1)[0] ?? reference;
}

export function addAssetNote(reference: string): void {
  const heading = headingOf(reference);
  const existing = assetNotesAtom.get().filter((n) => headingOf(n) !== heading);

  assetNotesAtom.set([...existing, reference].slice(-MAX_NOTES));
}

/** Cleared when switching projects, so one project's asset notes never leak into another's context. */
export function clearAssetNotes(): void {
  assetNotesAtom.set([]);
}
