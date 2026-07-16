/**
 * The store catalog, as server code reads it (SPEC §4.9).
 *
 * `app/config/assets.json` is the source of truth (DATA, not code). This module gives the rest of the
 * server a typed, id-addressable view of it — the catalog route renders the grid, and the add path asks
 * "is this a real catalog item, and is it premium?" before it lets anything into a project.
 *
 * Premium items carry a `priceCents`; when one is marked premium without a price, we fall back to a
 * single default rather than silently selling it for nothing.
 */
import catalog from '~/config/assets.json';

export type CatalogKind = 'scene' | 'prefab' | 'pack';

export interface CatalogItem {
  id: string;
  title: string;
  description?: string;
  kind: CatalogKind;
  premium: boolean;

  /** One-time price in cents for a premium item. Free items omit it. */
  priceCents?: number;

  /** Hosted-scene URL / prefab or pack asset URL — whichever this kind uses. */
  url?: string;

  /** Component reference for a prefab (§4.9) — what the agent scaffolds against. */
  components?: string[];
}

/** Default one-time price for a premium item that does not name its own (never sell for $0). */
export const DEFAULT_PREMIUM_ASSET_PRICE_CENTS = 900;

interface RawItem {
  id: string;
  title: string;
  description?: string;
  premium?: boolean;
  priceCents?: number;
  sceneUrl?: string;
  assetUrl?: string;
  components?: string[];
}

function normalize(raw: RawItem, kind: CatalogKind): CatalogItem {
  const premium = Boolean(raw.premium);

  return {
    id: raw.id,
    title: raw.title,
    description: raw.description,
    kind,
    premium,
    priceCents: premium ? (raw.priceCents ?? DEFAULT_PREMIUM_ASSET_PRICE_CENTS) : undefined,
    url: raw.sceneUrl ?? raw.assetUrl,
    components: raw.components,
  };
}

/** Every catalog item across all three sections, flattened with its kind. */
export function allCatalogItems(): CatalogItem[] {
  return [
    ...(catalog.scenes as RawItem[]).map((r) => normalize(r, 'scene')),
    ...(catalog.prefabs as RawItem[]).map((r) => normalize(r, 'prefab')),
    ...(catalog.packs as RawItem[]).map((r) => normalize(r, 'pack')),
  ];
}

/** Resolve a catalog item by id, or null. The add path uses this — never trust a client-supplied shape. */
export function findCatalogItem(id: string): CatalogItem | null {
  return allCatalogItems().find((item) => item.id === id) ?? null;
}
