/**
 * The KIE marketplace price list — types, validation, and price lookup (SPEC §4.6, spec/billing.md).
 *
 * ONE document holds every price the platform pays KIE: the LLM token rates (which
 * `billing/rates.ts` turns into `ModelRates`) and the per-task media prices (which the §4.16 media
 * routes will debit up-front). It replaces the `KIE_INPUT_DOLLARS` / `PREMIUM_*_DOLLARS` env vars:
 * prices are updated from the Admin panel ("Marketplace prices") as promoted, versioned, rollbackable
 * lists — doc-sync rules applied to money (`market-price-store.ts`) — never by editing a deploy's
 * environment.
 *
 * Everything in this file is PURE and exhaustively tested (`market-prices.spec.ts`), because every
 * consumer is a money path and every way a price list can be wrong is silent: a malformed list that
 * half-loads prices some models and not others; a zero price zero-rates a model forever; a media
 * variant that matches nothing refuses work the operator believes is priced.
 */

/** USD per million tokens. Cache rates deliberately absent — they DERIVE (0.1x read / 2.0x 1h write). */
export interface LlmMarketRate {
  inputPerMTok: number;
  outputPerMTok: number;
}

export type MediaKind = 'image' | 'video';

/**
 * How a variant's `usd` converts to a task price:
 *  - `per_image` / `per_video`: flat.
 *  - `per_second`: multiplied by the requested duration (which the request must therefore state).
 */
export type MediaUnit = 'per_image' | 'per_second' | 'per_video';

/**
 * One priced configuration of a media model.
 *
 * `options` mirrors the fields we send in the KIE createTask request (resolution, mode, sound, …).
 * A variant PRICES a request when every option it declares matches the request's value for that key —
 * a subset match, so a variant that omits `sound` prices both sound settings (used where KIE prices
 * them identically, e.g. Kling 3.0 4K).
 */
export interface MediaPriceVariant {
  options: Record<string, string | number | boolean>;
  usd: number;
}

export interface MediaModelPricing {
  kind: MediaKind;

  /** Display name for the Admin panel and the media UI. */
  label: string;

  /** Who actually makes the model (Google, Kling, ByteDance…). KIE is the reseller, never the vendor. */
  vendor: string;

  unit: MediaUnit;

  /**
   * Other KIE model slugs that share this row's pricing (e.g. kling-2.6's text-to-video and
   * image-to-video slugs). Lookup by alias resolves to this row.
   */
  aliases?: string[];

  variants: MediaPriceVariant[];
}

export interface MarketPriceList {
  schemaVersion: 1;

  /** When these numbers were captured from KIE (ISO date). The admin panel shows it as staleness. */
  capturedAt: string;

  /** Where they came from — provenance for an audit, not machine-read. */
  source: string;

  llm: Record<string, LlmMarketRate>;
  media: Record<string, MediaModelPricing>;
}

export const MARKET_PRICE_SCHEMA_VERSION = 1;

/*
 * ------------------------------------------------------------------------------------------------ *
 * Validation
 * ------------------------------------------------------------------------------------------------
 */

export type ValidationResult = { ok: true; list: MarketPriceList } | { ok: false; errors: string[] };

/**
 * A price must be a positive finite number. Zero is refused everywhere for the same reason `envMoney`
 * refused it: a free model does not exist, so `0` is a typo that would zero-rate real spend forever.
 */
function isPrice(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Full structural validation of an untrusted list — the wall every promotion passes through before it
 * can price anything (`market-price-store.ts` refuses to store a list this rejects).
 *
 * Collects EVERY error rather than throwing at the first: the admin fixing a pasted list needs the
 * whole picture, not a fix-one-refresh-repeat loop.
 */
export function validateMarketPriceList(value: unknown): ValidationResult {
  const errors: string[] = [];

  if (!isPlainObject(value)) {
    return { ok: false, errors: ['The price list must be a JSON object.'] };
  }

  if (value.schemaVersion !== MARKET_PRICE_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${MARKET_PRICE_SCHEMA_VERSION} (got ${JSON.stringify(value.schemaVersion)}).`);
  }

  if (typeof value.capturedAt !== 'string' || !value.capturedAt.trim()) {
    errors.push('capturedAt (ISO date string) is required — the admin panel shows it as price staleness.');
  }

  if (typeof value.source !== 'string' || !value.source.trim()) {
    errors.push('source (provenance string) is required.');
  }

  if (!isPlainObject(value.llm)) {
    errors.push('llm must be an object of model → { inputPerMTok, outputPerMTok }.');
  } else {
    if (Object.keys(value.llm).length === 0) {
      // An empty LLM table would refuse every generation the moment it is promoted.
      errors.push('llm must price at least one model — an empty table cannot bill anything.');
    }

    for (const [model, rate] of Object.entries(value.llm)) {
      if (!isPlainObject(rate)) {
        errors.push(`llm["${model}"] must be an object.`);
        continue;
      }

      if (!isPrice(rate.inputPerMTok)) {
        errors.push(`llm["${model}"].inputPerMTok must be a positive number of USD per million tokens.`);
      }

      if (!isPrice(rate.outputPerMTok)) {
        errors.push(`llm["${model}"].outputPerMTok must be a positive number of USD per million tokens.`);
      }

      const extras = Object.keys(rate).filter((k) => k !== 'inputPerMTok' && k !== 'outputPerMTok');

      if (extras.length) {
        /*
         * Cache rates are DERIVED (0.1x read / 2.0x 1h write, measured on KIE — rates.ts). A list
         * that quotes them is stating a second opinion about a derived number, and the two WILL
         * drift. Refused rather than ignored: ignored config is how `KIE_CACHED_INPUT` half-bugs
         * were born.
         */
        errors.push(
          `llm["${model}"] has unsupported keys [${extras.join(', ')}] — only inputPerMTok/outputPerMTok; ` +
            'cache rates derive (0.1x read, 2.0x write) and cannot be quoted here.',
        );
      }
    }
  }

  if (!isPlainObject(value.media)) {
    errors.push('media must be an object of model → pricing (it may be empty).');
  } else {
    const seenSlugs = new Map<string, string>();

    for (const [model, pricing] of Object.entries(value.media)) {
      validateMediaModel(model, pricing, errors);

      if (!isPlainObject(pricing)) {
        continue;
      }

      // Aliases and ids share one namespace: a duplicate would make a lookup silently ambiguous.
      const slugs = [model, ...(Array.isArray(pricing.aliases) ? (pricing.aliases as string[]) : [])];

      for (const slug of slugs) {
        const already = seenSlugs.get(slug);

        if (already !== undefined && already !== model) {
          errors.push(`"${slug}" is claimed by both "${already}" and "${model}" — a lookup would be ambiguous.`);
        }

        seenSlugs.set(slug, model);
      }
    }
  }

  return errors.length ? { ok: false, errors } : { ok: true, list: value as unknown as MarketPriceList };
}

function validateMediaModel(model: string, pricing: unknown, errors: string[]): void {
  if (!isPlainObject(pricing)) {
    errors.push(`media["${model}"] must be an object.`);
    return;
  }

  if (pricing.kind !== 'image' && pricing.kind !== 'video') {
    errors.push(`media["${model}"].kind must be "image" or "video".`);
  }

  if (typeof pricing.label !== 'string' || !pricing.label.trim()) {
    errors.push(`media["${model}"].label is required.`);
  }

  if (typeof pricing.vendor !== 'string' || !pricing.vendor.trim()) {
    errors.push(`media["${model}"].vendor is required.`);
  }

  if (pricing.unit !== 'per_image' && pricing.unit !== 'per_second' && pricing.unit !== 'per_video') {
    errors.push(`media["${model}"].unit must be per_image, per_second or per_video.`);
  }

  if (pricing.aliases !== undefined) {
    if (!Array.isArray(pricing.aliases) || pricing.aliases.some((a) => typeof a !== 'string' || !a.trim())) {
      errors.push(`media["${model}"].aliases must be an array of non-empty strings.`);
    }
  }

  if (!Array.isArray(pricing.variants) || pricing.variants.length === 0) {
    errors.push(`media["${model}"].variants must be a non-empty array — a model with no priced variant cannot run.`);
    return;
  }

  const seenOptionSets = new Set<string>();

  for (const [i, variant] of pricing.variants.entries()) {
    if (!isPlainObject(variant)) {
      errors.push(`media["${model}"].variants[${i}] must be an object.`);
      continue;
    }

    if (!isPrice(variant.usd)) {
      errors.push(`media["${model}"].variants[${i}].usd must be a positive number of US dollars.`);
    }

    if (!isPlainObject(variant.options)) {
      errors.push(`media["${model}"].variants[${i}].options must be an object (it may be empty).`);
      continue;
    }

    for (const [key, optionValue] of Object.entries(variant.options)) {
      const t = typeof optionValue;

      if (t !== 'string' && t !== 'number' && t !== 'boolean') {
        errors.push(`media["${model}"].variants[${i}].options["${key}"] must be a string, number or boolean.`);
      }
    }

    /*
     * Two variants with identical options would price one request two ways, and which one wins would
     * be array order — a coin flip wearing a price tag.
     */
    const signature = JSON.stringify(
      Object.entries(variant.options)
        .map(([k, v]) => [k, v] as const)
        .sort(([a], [b]) => a.localeCompare(b)),
    );

    if (seenOptionSets.has(signature)) {
      errors.push(`media["${model}"] has two variants with identical options ${signature} — ambiguous pricing.`);
    }

    seenOptionSets.add(signature);
  }
}

/*
 * ------------------------------------------------------------------------------------------------ *
 * Lookup
 * ------------------------------------------------------------------------------------------------
 */

/** Resolve a model slug (or alias) to its media pricing row, or null. */
export function findMediaModel(
  list: MarketPriceList,
  model: string,
): { id: string; pricing: MediaModelPricing } | null {
  const direct = list.media[model];

  if (direct) {
    return { id: model, pricing: direct };
  }

  for (const [id, pricing] of Object.entries(list.media)) {
    if (pricing.aliases?.includes(model)) {
      return { id, pricing };
    }
  }

  return null;
}

export interface MediaPriceQuery {
  /** The KIE model slug the createTask request will name. */
  model: string;

  /** The request options (resolution, mode, sound, durationSeconds, imageInput…). */
  options: Record<string, string | number | boolean>;

  /** Required for `per_second` models — the price is meaningless without it. */
  durationSeconds?: number;
}

export interface MediaPrice {
  /** The canonical model id the price came from (aliases resolve). */
  model: string;

  /** The task's total raw cost to us, USD. What the credit charge is computed FROM. */
  usd: number;

  unit: MediaUnit;
  variant: MediaPriceVariant;
}

/**
 * Price a media generation request, or return null — and null means REFUSE, never guess.
 *
 * Matching: a variant applies when every option it declares equals the request's value for that key
 * (subset match). The MOST SPECIFIC applicable variant wins (most declared options), so a catch-all
 * row can coexist with a priced special case. Ties in specificity cannot price two ways because
 * validation refuses duplicate option sets.
 *
 * ⚠️ There is deliberately NO most-expensive fallback here, unlike `ratesFor`. LLM settlement happens
 * AFTER spend, where over-charging ourselves is the safe direction; media debits happen BEFORE spend,
 * where the safe direction is to not spend at all.
 */
export function lookupMediaPrice(list: MarketPriceList, query: MediaPriceQuery): MediaPrice | null {
  const found = findMediaModel(list, query.model);

  if (!found) {
    return null;
  }

  const { id, pricing } = found;

  let best: MediaPriceVariant | null = null;
  let bestSpecificity = -1;

  for (const variant of pricing.variants) {
    const keys = Object.keys(variant.options);
    const applies = keys.every((key) => variantOptionMatches(variant.options[key], query.options[key]));

    if (applies && keys.length > bestSpecificity) {
      best = variant;
      bestSpecificity = keys.length;
    }
  }

  if (!best) {
    return null;
  }

  if (pricing.unit === 'per_second') {
    const duration = query.durationSeconds;

    if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0) {
      // A per-second price with no duration is not a price. Refuse, don't assume a duration.
      return null;
    }

    return { model: id, usd: best.usd * duration, unit: pricing.unit, variant: best };
  }

  return { model: id, usd: best.usd, unit: pricing.unit, variant: best };
}

/**
 * String option values compare case-insensitively: KIE's own docs and feed mix `4K`/`4k` and
 * `720P`/`720p`, and a price that fails to match because of a capital letter is a refusal the
 * operator cannot see coming. Numbers and booleans compare strictly.
 */
function variantOptionMatches(variantValue: string | number | boolean, requestValue: unknown): boolean {
  if (typeof variantValue === 'string' && typeof requestValue === 'string') {
    return variantValue.toLowerCase() === requestValue.toLowerCase();
  }

  return variantValue === requestValue;
}
