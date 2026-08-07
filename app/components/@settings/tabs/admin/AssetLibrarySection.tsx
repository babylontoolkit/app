/**
 * Asset library — the Admin panel's control over the Synty prototype manifest the model sees (§4.4d).
 *
 * The owner exports the Synty packs from Unity and publishes a master `assets.json` at
 * repo.babylontoolkit.com; this section fetches it FOR REVIEW, and promotion is the deliberate act
 * that changes what generations are told is available. Nothing is machine-applied, and unpinning is
 * how "the library goes away" — the prompt block simply stops being emitted.
 *
 * The route (`/api/admin/asset-library`) is the security boundary and the validator; this component
 * renders what it returns and shows every validation error on a refused promotion.
 */
import { useEffect, useState } from 'react';
import { toast } from 'react-toastify';

interface AssetLibraryState {
  /** The Use-Asset-Library feature switch (Settings → Admin → Features). */
  enabled: boolean;
  active: {
    versionId: string | null;
    packCount: number;
    assetCount: number;
    baseUrl: string | null;
    index: string | null;
  };
  pointer: { versionId: string } | null;
  versions: Array<{ versionId: string; size: number; storedAt?: string; active: boolean }>;
  masterUrl: string;
  storage: string;
}

export function AssetLibrarySection() {
  const [state, setState] = useState<AssetLibraryState | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [note, setNote] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const [showIndex, setShowIndex] = useState(false);

  const load = () => {
    fetch('/api/admin/asset-library')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => data && setState(data as AssetLibraryState))
      .catch(() => undefined);
  };

  useEffect(load, []);

  const post = async (body: Record<string, unknown>) => {
    const r = await fetch('/api/admin/asset-library', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    return { ok: r.ok, data: (await r.json()) as Record<string, unknown> };
  };

  const fetchMaster = async () => {
    setBusy(true);
    setErrors([]);

    try {
      const { ok, data } = await post({ action: 'fetch-master' });

      if (!ok) {
        toast.error(String(data.message ?? 'Could not fetch the master manifest.'));
        return;
      }

      // Into the editor for REVIEW — promotion stays a separate, deliberate press.
      setDraft(JSON.stringify(data.candidate, null, 2));
      setEditing(true);
      toast.success('Master manifest fetched — review it, then promote.');
    } finally {
      setBusy(false);
    }
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
      const { ok, data } = await post({ action: 'promote', manifest: parsed, note });

      if (!ok) {
        // The route returns EVERY validation error at once — show them all, not just the first.
        setErrors((data.errors as string[]) ?? [String(data.message ?? 'Promotion refused.')]);
        return;
      }

      const pointer = data.pointer as { versionId: string };

      // While the feature switch is off, a promotion moves the pin but the model still sees nothing.
      toast.success(
        state?.enabled === false
          ? `Asset library promoted — ${pointer.versionId} is pinned, but stays dormant until "Use Asset Library" is switched on.`
          : `Asset library promoted — ${pointer.versionId} is what the model now sees.`,
      );
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

      toast.success(`Rolled the asset library back to ${versionId}.`);
      load();
    } finally {
      setBusy(false);
    }
  };

  const unpin = async () => {
    if (!confirm('Unpin the asset library? Generations will run without one until a version is promoted again.')) {
      return;
    }

    setBusy(true);

    try {
      const { ok, data } = await post({ action: 'unpin' });

      if (!ok) {
        toast.error(String(data.message ?? 'Unpin failed.'));
        return;
      }

      toast.success('Asset library unpinned.');
      load();
    } finally {
      setBusy(false);
    }
  };

  if (!state) {
    return (
      <section>
        <h3 className="text-sm font-semibold text-bolt-elements-textPrimary">Asset library</h3>
        <div className="mt-2 text-sm text-bolt-elements-textSecondary">Loading…</div>
      </section>
    );
  }

  const { active } = state;

  return (
    <section>
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-bolt-elements-textPrimary">Asset library</h3>
        <div className="flex gap-2">
          <button
            className="text-xs px-2 py-1 rounded bg-bolt-elements-background-depth-3 text-bolt-elements-textSecondary disabled:opacity-50"
            disabled={busy}
            onClick={() => void fetchMaster()}
          >
            Fetch master manifest
          </button>
          <button
            className="text-xs px-2 py-1 rounded bg-bolt-elements-background-depth-3 text-bolt-elements-textSecondary disabled:opacity-50"
            disabled={busy}
            onClick={() => {
              setErrors([]);
              setEditing((e) => !e);
            }}
          >
            {editing ? 'Close editor' : 'Edit manifest'}
          </button>
          {(active.versionId || state.pointer) && (
            <button
              className="text-xs px-2 py-1 rounded bg-red-500/10 text-red-500 disabled:opacity-50"
              disabled={busy}
              onClick={() => void unpin()}
            >
              Unpin
            </button>
          )}
        </div>
      </div>

      {/*
       * Three honest states, not two: serving, pinned-but-DISABLED (the feature switch above is off —
       * without this line a disabled library reads as "no library pinned", and the admin re-promotes
       * a manifest that was there all along), and genuinely unpinned.
       */}
      <div className="mt-2 text-xs text-bolt-elements-textTertiary">
        {active.versionId ? (
          `Active version ${active.versionId} · ${active.packCount} packs, ${active.assetCount} assets · ${active.baseUrl ?? ''} · stored in ${state.storage}`
        ) : !state.enabled && state.pointer ? (
          <span className="text-amber-500">
            {`Version ${state.pointer.versionId} is pinned but DORMANT — "Use Asset Library" is switched off in Features above, so the model is not told about it.`}
          </span>
        ) : (
          `No library pinned — generations run without one. Master: ${state.masterUrl}`
        )}
      </div>

      {/* The exact block the model sees — reading what was just bought, not a summary of it. */}
      {active.index && (
        <div className="mt-2">
          <button
            className="text-xs text-bolt-elements-textSecondary underline"
            onClick={() => setShowIndex((s) => !s)}
          >
            {showIndex
              ? 'Hide the prompt block'
              : `Show the prompt block the model sees (${active.index.length} chars)`}
          </button>
          {showIndex && (
            <pre className="mt-1 max-h-64 overflow-auto rounded-md border border-bolt-elements-borderColor p-2 text-[11px] text-bolt-elements-textSecondary whitespace-pre-wrap">
              {active.index}
            </pre>
          )}
        </div>
      )}

      {editing && (
        <div className="mt-2">
          <textarea
            className="w-full h-56 rounded-md border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 p-2 font-mono text-[11px] text-bolt-elements-textPrimary"
            spellCheck={false}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder='{"version": 1, "baseUrl": "https://repo.babylontoolkit.com/", "packs": [...]}'
          />
          <div className="mt-1 flex items-center gap-2">
            <input
              className="flex-1 rounded-md border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 px-2 py-1 text-xs text-bolt-elements-textPrimary"
              placeholder="Note (optional) — e.g. August Synty export"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
            <button
              className="text-xs px-3 py-1 rounded bg-accent-500 text-white disabled:opacity-50"
              disabled={busy || draft.trim().length === 0}
              onClick={() => void promote()}
            >
              Promote
            </button>
          </div>
          {errors.length > 0 && (
            <div className="mt-2 rounded-md border border-red-500/30 bg-red-500/5 p-2">
              <div className="text-xs font-medium text-red-500">The manifest was refused:</div>
              <ul className="mt-1 list-disc pl-4 text-[11px] text-red-400">
                {errors.map((error, i) => (
                  <li key={i}>{error}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {state.versions.length > 0 && (
        <div className="mt-2 rounded-md border border-bolt-elements-borderColor">
          {state.versions.map((version) => (
            <div
              key={version.versionId}
              className="flex items-center justify-between border-t first:border-t-0 border-bolt-elements-borderColor px-3 py-1.5"
            >
              <div className="text-xs text-bolt-elements-textSecondary">
                {version.versionId}
                {version.active && <span className="ml-2 text-green-500">active</span>}
                <span className="text-bolt-elements-textTertiary">
                  {' '}
                  · {(version.size / 1024).toFixed(1)} KB{version.storedAt ? ` · ${version.storedAt}` : ''}
                </span>
              </div>
              {!version.active && (
                <button
                  className="text-xs px-2 py-1 rounded bg-bolt-elements-background-depth-3 text-bolt-elements-textSecondary disabled:opacity-50"
                  disabled={busy}
                  onClick={() => void rollback(version.versionId)}
                >
                  Roll back
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
