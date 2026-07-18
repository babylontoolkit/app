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
}
interface MarketPricesState {
  active: { versionId: string | null; list: PriceList };
  versions: Array<{ versionId: string; size: number; storedAt?: string; active: boolean }>;
  baked: PriceList;
  storage: string;
}
interface FeedRow {
  modelDescription: string;
  interfaceType: string;
  provider: string;
  usdPrice: string;
  creditUnit: string;
}

const UNIT_LABEL: Record<MediaRow['unit'], string> = {
  per_image: 'per image',
  per_second: 'per second',
  per_video: 'per video',
};

export function MarketPricesSection() {
  const [state, setState] = useState<MarketPricesState | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [note, setNote] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const [feed, setFeed] = useState<FeedRow[] | null>(null);
  const [feedFilter, setFeedFilter] = useState('');

  const load = () => {
    fetch('/api/admin/market-prices')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => data && setState(data as MarketPricesState))
      .catch(() => undefined);
  };

  useEffect(load, []);

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
      const { ok, data } = await post({ action: 'promote', list: parsed, note });

      if (!ok) {
        // The route returns EVERY validation error at once — show them all, not just the first.
        setErrors((data.errors as string[]) ?? [String(data.message ?? 'Promotion refused.')]);
        return;
      }

      const pointer = data.pointer as { versionId: string };
      toast.success(`Prices promoted — ${pointer.versionId} is live for all billing.`);
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
      const { ok, data } = await post({ action: 'rollback', versionId });

      if (!ok) {
        toast.error(String(data.message ?? 'Rollback failed.'));
        return;
      }

      toast.success(`Rolled prices back to ${versionId}.`);
      load();
    } finally {
      setBusy(false);
    }
  };

  const fetchFeed = async () => {
    setBusy(true);

    try {
      const { ok, data } = await post({ action: 'fetch-feed' });

      if (!ok) {
        toast.error(String(data.message ?? 'Could not reach the kie.ai pricing feed.'));
        return;
      }

      const result = data.feed as { rows: FeedRow[]; reportedTotal: number };
      setFeed(result.rows);
      toast.success(`Fetched ${result.rows.length} of ${result.reportedTotal} kie.ai price rows.`);
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
    (row) => !feedFilter || row.modelDescription.toLowerCase().includes(feedFilter.toLowerCase()),
  );

  return (
    <section>
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-bolt-elements-textPrimary">Marketplace prices</h3>
        <div className="flex gap-2">
          <button
            className="text-xs px-2 py-1 rounded bg-bolt-elements-background-depth-3 text-bolt-elements-textSecondary disabled:opacity-50"
            disabled={busy}
            onClick={() => void fetchFeed()}
          >
            Fetch kie.ai feed
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
        {active.versionId
          ? `Active version ${active.versionId} · stored in ${state.storage}`
          : 'Using the BAKED defaults (nothing promoted yet)'}
        {' · '}captured {active.list.capturedAt}
      </div>

      {/* What LLM billing is using right now. Cache always derives: 0.1x read / 2.0x write (1h tier). */}
      <div className="mt-2 rounded-md border border-bolt-elements-borderColor overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-bolt-elements-textTertiary">
              <th className="px-3 py-1.5 font-medium">LLM model</th>
              <th className="px-3 py-1.5 font-medium text-right">Input $/MTok</th>
              <th className="px-3 py-1.5 font-medium text-right">Output $/MTok</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(active.list.llm).map(([model, row]) => (
              <tr key={model} className="border-t border-bolt-elements-borderColor">
                <td className="px-3 py-1.5 text-bolt-elements-textPrimary">{model}</td>
                <td className="px-3 py-1.5 text-right text-bolt-elements-textSecondary">${row.inputPerMTok}</td>
                <td className="px-3 py-1.5 text-right text-bolt-elements-textSecondary">${row.outputPerMTok}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="px-3 py-1.5 text-[11px] text-bolt-elements-textTertiary border-t border-bolt-elements-borderColor">
          Cache prices derive per row: 0.1× input (reads) / 2.0× input (1-hour writes) — never quoted separately.
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

      {/* KIE's own feed, for the operator's eyes — comparison only, never machine-applied. */}
      {shownFeed && (
        <div className="mt-2 rounded-md border border-bolt-elements-borderColor">
          <div className="flex items-center gap-2 px-3 py-1.5 border-b border-bolt-elements-borderColor">
            <input
              className="flex-1 text-xs px-2 py-1 rounded-md border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 text-bolt-elements-textPrimary"
              placeholder="Filter kie.ai rows (e.g. kling, banana, claude)…"
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
                    <td className="px-3 py-1 text-bolt-elements-textSecondary">{row.modelDescription}</td>
                    <td className="px-3 py-1 text-bolt-elements-textTertiary">{row.interfaceType}</td>
                    <td className="px-3 py-1 text-right text-bolt-elements-textPrimary whitespace-nowrap">
                      ${row.usdPrice} <span className="text-bolt-elements-textTertiary">{row.creditUnit}</span>
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
