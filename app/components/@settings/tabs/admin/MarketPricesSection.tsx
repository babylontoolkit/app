/**
 * Marketplace prices — the Admin panel's control over what the platform believes KIE charges (§4.6).
 *
 * The active list prices EVERYTHING the platform bills: LLM tokens now, media generation (§4.16) as
 * it lands. Ordinary maintenance happens here — fetch KIE's feed for comparison, edit the JSON,
 * promote — never by editing env vars (retired) or redeploying (the baked list is only the fallback).
 *
 * The route (`/api/admin/market-prices`) is the security boundary and the validator; this component
 * renders what it returns and shows every validation error on a refused promotion.
 */
import { useEffect, useState } from 'react';
import { toast } from 'react-toastify';

interface LlmRow {
  inputPerMTok: number;
  outputPerMTok: number;

  /** gpt-* rows only — KIE publishes both, and the pair is atomic (see `market-prices.ts`). */
  cachedInputPerMTok?: number;
  cacheWritePerMTok?: number;
}
interface MediaVariant {
  options: Record<string, string | number | boolean>;
  usd: number;
}
interface MediaRow {
  kind: 'image' | 'video';
  label: string;
  vendor: string;
  unit: 'per_image' | 'per_second' | 'per_video';
  aliases?: string[];
  variants: MediaVariant[];
}
interface PriceList {
  schemaVersion: number;
  capturedAt: string;
  source: string;
  llm: Record<string, LlmRow>;
  media: Record<string, MediaRow>;
  search?: { creditsPerSearch: number };
}
interface MarketPricesState {
  /** Which marketplace the SERVER loaded. Optional so an older bundle against a newer route still renders. */
  provider?: string;

  /** Every marketplace the route offers — the selector must not hold its own copy of this list. */
  providers?: string[];

  active: { versionId: string | null; list: PriceList };
  versions: Array<{ versionId: string; size: number; storedAt?: string; active: boolean }>;
  baked: PriceList;
  storage: string;
}

/**
 * One row of a vendor's pricing feed, NORMALISED — the two vendors publish different shapes.
 *
 * KIE returns display STRINGS (`modelDescription`, `usdPrice`); Comet returns numbers plus a
 * per-row `ratio`, where the charged rate is `official x ratio`. Rather than render one shape and
 * silently blank the other, the panel maps both onto {label, detail, price} at the fetch seam.
 *
 * 🔴 For Comet the price shown is the CHARGED one, with the official rate and the ratio beside it.
 * Showing `pricing.input` alone would show a number that is not what we pay — the exact misreading
 * that produced "no discount on Opus 5" during this feature's investigation.
 */
interface FeedRow {
  label: string;
  detail: string;
  price: string;
}

const UNIT_LABEL: Record<MediaRow['unit'], string> = {
  per_image: 'per image',
  per_second: 'per second',
  per_video: 'per video',
};

/**
 * Which marketplace the panel is editing.
 *
 * 🔴 It rides in EVERY request, and a promotion targets whichever provider is selected — so the
 * selected value and the displayed list must never come apart. `load()` re-fetches on every change
 * and the response echoes its own `provider` back, which is what the header renders: the panel shows
 * what the SERVER says it loaded, never what the local state hoped for. Promoting Comet's rates
 * over KIE's pointer is a silent repricing of every generation, so this is not a cosmetic filter.
 */
type PriceProvider = 'KIE' | 'Comet';

/**
 * Map a vendor feed row onto the panel's three columns.
 *
 * ⚠️ The Comet branch shows `charged` as the headline and the official rate + ratio as the detail,
 * because the charged number is the one that has to match the promoted list. A `ratio` that is not
 * 0.8 is the interesting case (three rows carry 1.0), so it is always printed rather than elided when
 * it happens to be the common value.
 */
function normaliseFeedRow(row: Record<string, unknown>, provider: PriceProvider): FeedRow {
  if (provider === 'Comet') {
    const inCharged = row.chargedInputPerMTok as number | null;
    const outCharged = row.chargedOutputPerMTok as number | null;
    const ratio = row.ratio as number | null;

    return {
      label: String(row.id ?? ''),
      detail:
        `${row.modelType ?? ''}` +
        (ratio == null ? '' : ` · official $${row.officialInputPerMTok}/$${row.officialOutputPerMTok} × ${ratio}`),
      price: inCharged == null ? '—' : `$${inCharged} / $${outCharged} per MTok`,
    };
  }

  return {
    label: String(row.modelDescription ?? ''),
    detail: String(row.interfaceType ?? ''),
    price: `$${row.usdPrice ?? '?'} ${row.creditUnit ?? ''}`,
  };
}

export function MarketPricesSection() {
  const [provider, setProvider] = useState<PriceProvider>('KIE');
  const [state, setState] = useState<MarketPricesState | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [note, setNote] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const [feed, setFeed] = useState<FeedRow[] | null>(null);
  const [feedFilter, setFeedFilter] = useState('');

  const load = (which: PriceProvider = provider) => {
    fetch(`/api/admin/market-prices?provider=${encodeURIComponent(which)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => data && setState(data as MarketPricesState))
      .catch(() => undefined);
  };

  useEffect(() => {
    /*
     * Clear the loaded list BEFORE fetching the new provider's, so the panel cannot show one
     * provider's prices under the other's name for the duration of a round trip. A stale table under
     * a switched heading is exactly the misreading that gets the wrong list promoted.
     */
    setState(null);
    setFeed(null);
    setEditing(false);
    load(provider);
  }, [provider]);

  const post = async (body: Record<string, unknown>) => {
    const r = await fetch('/api/admin/market-prices', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    return { ok: r.ok, data: (await r.json()) as Record<string, unknown> };
  };

  const promote = async () => {
    let parsed: unknown;

    try {
      parsed = JSON.parse(draft);
    } catch (error) {
      setErrors([`Not valid JSON: ${(error as Error).message}`]);
      return;
    }

    setBusy(true);
    setErrors([]);

    try {
      const { ok, data } = await post({ action: 'promote', provider, list: parsed, note });

      if (!ok) {
        // The route returns EVERY validation error at once — show them all, not just the first.
        setErrors((data.errors as string[]) ?? [String(data.message ?? 'Promotion refused.')]);
        return;
      }

      const pointer = data.pointer as { versionId: string };
      toast.success(`${provider} prices promoted — ${pointer.versionId} is live for all billing.`);
      setEditing(false);
      setNote('');
      load();
    } finally {
      setBusy(false);
    }
  };

  const rollback = async (versionId: string) => {
    setBusy(true);

    try {
      const { ok, data } = await post({ action: 'rollback', provider, versionId });

      if (!ok) {
        toast.error(String(data.message ?? 'Rollback failed.'));
        return;
      }

      toast.success(`Rolled ${provider} prices back to ${versionId}.`);
      load();
    } finally {
      setBusy(false);
    }
  };

  const fetchFeed = async () => {
    setBusy(true);

    try {
      const { ok, data } = await post({ action: 'fetch-feed', provider });

      if (!ok) {
        toast.error(String(data.message ?? `Could not reach the ${provider} pricing feed.`));
        return;
      }

      const result = data.feed as { rows: Array<Record<string, unknown>>; reportedTotal: number };
      setFeed(result.rows.map((row) => normaliseFeedRow(row, provider)));
      toast.success(`Fetched ${result.rows.length} of ${result.reportedTotal} ${provider} price rows.`);
    } finally {
      setBusy(false);
    }
  };

  if (!state) {
    return (
      <section>
        <h3 className="text-sm font-semibold text-bolt-elements-textPrimary">Marketplace prices</h3>
        <div className="mt-2 text-sm text-bolt-elements-textSecondary">Loading…</div>
      </section>
    );
  }

  const { active } = state;
  const mediaEntries = Object.entries(active.list.media);
  const shownFeed = feed?.filter(
    (row) => !feedFilter || `${row.label} ${row.detail}`.toLowerCase().includes(feedFilter.toLowerCase()),
  );

  return (
    <section>
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-bolt-elements-textPrimary">Marketplace prices</h3>
        <div className="flex gap-2">
          {/*
           * Which marketplace is being edited. FIRST in the row and always visible, because every
           * other control on this panel acts on it — a promote button whose target is inferable only
           * from a heading further down is how the wrong list gets repriced.
           */}
          <select
            className="text-xs px-2 py-1 rounded bg-bolt-elements-background-depth-3 text-bolt-elements-textSecondary disabled:opacity-50"
            disabled={busy}
            value={provider}
            onChange={(e) => setProvider(e.target.value as PriceProvider)}
            aria-label="Price list provider"
          >
            {(state.providers ?? ['KIE', 'Comet']).map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
          <button
            className="text-xs px-2 py-1 rounded bg-bolt-elements-background-depth-3 text-bolt-elements-textSecondary disabled:opacity-50"
            disabled={busy}
            onClick={() => void fetchFeed()}
          >
            Fetch {provider} feed
          </button>
          <button
            className="text-xs px-2 py-1 rounded bg-bolt-elements-background-depth-3 text-bolt-elements-textSecondary disabled:opacity-50"
            disabled={busy}
            onClick={() => {
              setDraft(JSON.stringify(active.list, null, 2));
              setErrors([]);
              setEditing((e) => !e);
            }}
          >
            {editing ? 'Close editor' : 'Edit price list'}
          </button>
        </div>
      </div>

      <div className="mt-2 text-xs text-bolt-elements-textTertiary">
        {/* The SERVER's echo of what it loaded — never the local selector, which can be mid-switch. */}
        {state.provider ?? provider} ·{' '}
        {active.versionId
          ? `Active version ${active.versionId} · stored in ${state.storage}`
          : 'Using the BAKED defaults (nothing promoted yet)'}
        {' · '}captured {active.list.capturedAt}
      </div>

      {/* What LLM billing is using right now. Cache handling is per FAMILY — see the footer below. */}
      <div className="mt-2 rounded-md border border-bolt-elements-borderColor overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-bolt-elements-textTertiary">
              <th className="px-3 py-1.5 font-medium">LLM model</th>
              <th className="px-3 py-1.5 font-medium text-right">Input $/MTok</th>
              <th className="px-3 py-1.5 font-medium text-right">Output $/MTok</th>
              <th className="px-3 py-1.5 font-medium text-right">Cached in $/MTok</th>
              <th className="px-3 py-1.5 font-medium text-right">Cache write $/MTok</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(active.list.llm).map(([model, row]) => (
              <tr key={model} className="border-t border-bolt-elements-borderColor">
                <td className="px-3 py-1.5 text-bolt-elements-textPrimary">{model}</td>
                <td className="px-3 py-1.5 text-right text-bolt-elements-textSecondary">${row.inputPerMTok}</td>
                <td className="px-3 py-1.5 text-right text-bolt-elements-textSecondary">${row.outputPerMTok}</td>
                <td className="px-3 py-1.5 text-right text-bolt-elements-textSecondary">
                  {row.cachedInputPerMTok === undefined ? 'derived' : `$${row.cachedInputPerMTok}`}
                </td>
                <td className="px-3 py-1.5 text-right text-bolt-elements-textSecondary">
                  {row.cacheWritePerMTok === undefined ? 'derived' : `$${row.cacheWritePerMTok}`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="px-3 py-1.5 text-[11px] text-bolt-elements-textTertiary border-t border-bolt-elements-borderColor space-y-1">
          <div>
            Cache prices are per model FAMILY, derived from the model id. <strong>claude-*</strong>: derived per row
            (0.1× input for reads, 2.0× input for 1-hour writes) — quoting them is refused. <strong>gpt-*</strong>: KIE
            publishes both, so the row must quote <em>both</em> Cached in and Cache write — neither derives, and a
            half-quoted row is refused. <strong>gemini-*</strong>: KIE quotes no cached rate, so cached tokens bill at
            the full input rate — quoting them is refused.
          </div>
          <div>
            Rows are keyed by the <strong>API model id</strong> (dashes: <code>gpt-5-6-sol</code>), never by the display
            name in KIE's pricing feed (<code>gpt-5.6-sol</code>) — a feed name prices nothing real.
          </div>
        </div>
      </div>

      {/* Media pricing — what generate_image / generate_video will debit from (§4.16). */}
      {mediaEntries.length > 0 && (
        <div className="mt-2 rounded-md border border-bolt-elements-borderColor overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-bolt-elements-textTertiary">
                <th className="px-3 py-1.5 font-medium">Media model</th>
                <th className="px-3 py-1.5 font-medium">Kind</th>
                <th className="px-3 py-1.5 font-medium">Unit</th>
                <th className="px-3 py-1.5 font-medium text-right">USD range</th>
              </tr>
            </thead>
            <tbody>
              {mediaEntries.map(([model, row]) => {
                const prices = row.variants.map((v) => v.usd);
                const min = Math.min(...prices);
                const max = Math.max(...prices);

                return (
                  <tr key={model} className="border-t border-bolt-elements-borderColor">
                    <td className="px-3 py-1.5 text-bolt-elements-textPrimary">
                      {row.label}
                      <span className="text-bolt-elements-textTertiary"> · {model}</span>
                    </td>
                    <td className="px-3 py-1.5 text-bolt-elements-textSecondary">{row.kind}</td>
                    <td className="px-3 py-1.5 text-bolt-elements-textSecondary">{UNIT_LABEL[row.unit]}</td>
                    <td className="px-3 py-1.5 text-right text-bolt-elements-textSecondary">
                      {min === max ? `$${min}` : `$${min}–$${max}`}
                      <span className="text-bolt-elements-textTertiary"> · {row.variants.length} variants</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Web search billing — the flat credit toll for the agent's web_search research tool (§4.2). */}
      <div className="mt-2 rounded-md border border-bolt-elements-borderColor overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-bolt-elements-textTertiary">
              <th className="px-3 py-1.5 font-medium">Web search (web_search)</th>
              <th className="px-3 py-1.5 font-medium text-right">Credits / search</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-t border-bolt-elements-borderColor">
              <td className="px-3 py-1.5 text-bolt-elements-textPrimary">
                Flat toll per billable search
                <span className="text-bolt-elements-textTertiary"> · paid backends (SerpApi / Brave) only</span>
              </td>
              <td className="px-3 py-1.5 text-right text-bolt-elements-textSecondary">
                {active.list.search?.creditsPerSearch ?? state.baked.search?.creditsPerSearch ?? 0}
                {active.list.search === undefined && (
                  <span className="text-bolt-elements-textTertiary"> (baked default)</span>
                )}
              </td>
            </tr>
          </tbody>
        </table>
        <div className="px-3 py-1.5 text-[11px] text-bolt-elements-textTertiary border-t border-bolt-elements-borderColor">
          Free backends (DuckDuckGo / SearXNG) never bill. Set <code>search.creditsPerSearch</code> to 0 to stop billing
          search entirely. web_fetch is always free.
        </div>
      </div>

      {editing && (
        <div className="mt-2 flex flex-col gap-2">
          <textarea
            className="w-full h-64 font-mono text-xs p-2 rounded-md border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 text-bolt-elements-textPrimary"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            spellCheck={false}
          />
          {errors.length > 0 && (
            <div className="text-xs px-3 py-2 rounded-md bg-red-500/10 text-red-500">
              {errors.map((error, i) => (
                <div key={i}>{error}</div>
              ))}
            </div>
          )}
          <div className="flex items-center gap-2">
            <input
              className="flex-1 text-xs px-2 py-1.5 rounded-md border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 text-bolt-elements-textPrimary"
              placeholder="Note (e.g. 'Kling reprice, July feed')"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
            <button
              className="text-xs px-3 py-1.5 rounded bg-green-500/10 text-green-600 dark:text-green-400 disabled:opacity-50"
              disabled={busy}
              onClick={() => {
                if (confirm('Promote this price list? ALL billing prices from it immediately.')) {
                  void promote();
                }
              }}
            >
              Promote
            </button>
          </div>
        </div>
      )}

      {state.versions.filter((v) => !v.active).length > 0 && (
        <div className="mt-2 flex flex-col gap-1">
          {state.versions
            .filter((v) => !v.active)
            .map((v) => (
              <div
                key={v.versionId}
                className="flex items-center gap-2 px-3 py-1.5 rounded-md border border-bolt-elements-borderColor"
              >
                <div className="flex-1 min-w-0 text-xs text-bolt-elements-textSecondary truncate">
                  {v.versionId}
                  {v.storedAt ? ` · ${new Date(v.storedAt).toLocaleString()}` : ''}
                </div>
                <button
                  className="text-xs px-2 py-1 rounded bg-red-500/10 text-red-500 disabled:opacity-50"
                  disabled={busy}
                  onClick={() => {
                    if (confirm(`Roll ALL billing prices back to ${v.versionId}?`)) {
                      void rollback(v.versionId);
                    }
                  }}
                >
                  Roll back
                </button>
              </div>
            ))}
        </div>
      )}

      {/* The vendor's own feed, for the operator's eyes — comparison only, never machine-applied. */}
      {shownFeed && (
        <div className="mt-2 rounded-md border border-bolt-elements-borderColor">
          <div className="flex items-center gap-2 px-3 py-1.5 border-b border-bolt-elements-borderColor">
            <input
              className="flex-1 text-xs px-2 py-1 rounded-md border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 text-bolt-elements-textPrimary"
              placeholder={`Filter ${provider} rows (e.g. kling, banana, claude)…`}
              value={feedFilter}
              onChange={(e) => setFeedFilter(e.target.value)}
            />
            <button
              className="text-xs px-2 py-1 rounded bg-bolt-elements-background-depth-3 text-bolt-elements-textSecondary"
              onClick={() => setFeed(null)}
            >
              Close
            </button>
          </div>
          <div className="max-h-64 overflow-y-auto">
            <table className="w-full text-xs">
              <tbody>
                {shownFeed.map((row, i) => (
                  <tr key={i} className="border-t border-bolt-elements-borderColor first:border-t-0">
                    <td className="px-3 py-1 text-bolt-elements-textSecondary">{row.label}</td>
                    <td className="px-3 py-1 text-bolt-elements-textTertiary">{row.detail}</td>
                    <td className="px-3 py-1 text-right text-bolt-elements-textPrimary whitespace-nowrap">
                      {row.price}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}
