/**
 * Features — platform-wide capability switches, admin-only (first section of the Admin tab).
 *
 * Unlike the user-facing Settings → Features tab (client-local, per-browser), every switch here is a
 * SERVER-persisted operator decision that changes what generations are built with, for every user at
 * once. Each switch's enforcement lives at a server read seam, never in this component — the UI only
 * reports and requests; a client that never loads this tab is gated identically.
 *
 * First (and so far only) switch: **Use Asset Library** (SPEC §4.4d). ON: generations are told about
 * the pinned Synty prototype manifest and instructed to PREFER it over building models from
 * primitives whenever the user has not supplied assets. OFF: `activeAssetLibrary()` returns nothing,
 * so the prompt block, the creation-brief rule (conditional on that block) and everything downstream
 * behave as if no library was ever pinned — the pin itself is kept, dormant, for re-enabling.
 */
import { useEffect, useState } from 'react';
import { toast } from 'react-toastify';
import { Switch } from '~/components/ui/Switch';

interface FeaturesState {
  enabled: boolean;

  /** Whether a manifest is pinned at all — lets the copy say what the switch is actually governing. */
  pinnedVersionId: string | null;
}

export function AdminFeaturesSection() {
  const [state, setState] = useState<FeaturesState | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => {
    fetch('/api/admin/asset-library')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data) {
          const d = data as { enabled: boolean; pointer: { versionId: string } | null };
          setState({ enabled: d.enabled, pinnedVersionId: d.pointer?.versionId ?? null });
        }
      })
      .catch(() => undefined);
  };

  useEffect(load, []);

  const toggle = async (enabled: boolean) => {
    setBusy(true);

    try {
      const r = await fetch('/api/admin/asset-library', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'set-enabled', enabled }),
      });
      const data = (await r.json()) as { ok?: boolean; enabled?: boolean; message?: string };

      if (!r.ok || !data.ok) {
        toast.error(String(data.message ?? 'Could not change the feature.'));
        return;
      }

      setState((s) => (s ? { ...s, enabled: data.enabled === true } : s));
      toast.success(
        data.enabled
          ? 'Use Asset Library is ON — generations prefer the pinned Synty library.'
          : 'Use Asset Library is OFF — generations run as if no library were pinned.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <h3 className="text-sm font-semibold text-bolt-elements-textPrimary">Features</h3>
      <p className="mt-1 text-xs text-bolt-elements-textTertiary">
        Platform-wide switches — these change what every user&apos;s generations are built with.
      </p>

      <div className="mt-2 flex flex-col gap-2">
        <div className="rounded-md border border-bolt-elements-borderColor px-3 py-3">
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <div className="text-sm font-medium text-bolt-elements-textPrimary">Use Asset Library</div>
              <p className="mt-1 text-xs text-bolt-elements-textSecondary">
                Prefer the pinned <span className="font-medium">Synty Asset Library</span> when prototyping projects:
                whenever a request doesn&apos;t supply its own assets, the model sources 3D models, characters and
                levels from the library first, and only falls back to primitives when nothing suitable exists. Switched
                off, generations run as if no library were pinned — nothing about it reaches a project.
              </p>
              {state && !state.pinnedVersionId && state.enabled && (
                <p className="mt-1 text-xs text-amber-500">
                  No library is pinned yet — this switch has nothing to serve until one is promoted below.
                </p>
              )}
            </div>
            {/* Upstream Switch has no `disabled` prop (extend-not-rewrite) — the busy guard lives in the handler. */}
            {state === null ? (
              <span className="text-xs text-bolt-elements-textTertiary">Loading…</span>
            ) : (
              <Switch
                className={busy ? 'opacity-50' : undefined}
                checked={state.enabled}
                onCheckedChange={(checked) => {
                  if (!busy) {
                    void toggle(checked);
                  }
                }}
              />
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
