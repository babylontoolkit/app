/**
 * The Admin tab (SPEC §4.10).
 *
 * A thin dashboard over the admin routes: the usage/cost report (which DIAGNOSES spend — cache hit
 * rate, failure rate, wasted-output tokens, per-model cost), the gallery curation queue (approve/reject
 * — nothing is public until an admin acts), and the abuse-report queue (unpublish/dismiss).
 *
 * The routes themselves are the security boundary (`requireAdmin`, session `isAdmin`); this component
 * just renders what they return and shows "admins only" if they refuse. It never assumes the caller is
 * an admin — a non-admin simply sees the refusal, which is correct.
 */
import { useEffect, useState } from 'react';
import { toast } from 'react-toastify';

interface UsageReport {
  generations: number;
  failed: number;
  failureRate: number;
  creditsCharged: number;
  rawCostUsd: number;
  cacheHitRate: number;
  avgDurationMs: number;
  silentStepOutputTokens: number;
  visibleTextChars: number;
  charsPerOutputToken: number;
  byModel: Array<{ model: string; generations: number; rawCostUsd: number }>;
}
interface Submission {
  projectId: string;
  shareId: string;
  title: string;
  description?: string;
}
interface Report {
  id: string;
  projectId: string;
  shareId: string;
  reason?: string;
  createdAt: string;
}
interface TemplatePin {
  sha: string;
  ref: string;
  pinnedAt: string;
  pinnedBy: 'auto' | 'promote' | 'rollback';
  fileCount: number;
}
interface TemplateState {
  repo: string;
  pinningEnabled: boolean;
  pin: TemplatePin | null;
  snapshots: Array<{ sha: string; size: number; storedAt?: string; active: boolean }>;
  storage: string;
}

export function AdminTab() {
  const [forbidden, setForbidden] = useState(false);
  const [report, setReport] = useState<UsageReport | null>(null);
  const [submissions, setSubmissions] = useState<Submission[]>([]);
  const [reports, setReports] = useState<Report[]>([]);
  const [template, setTemplate] = useState<TemplateState | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => {
    fetch('/api/admin/usage')
      .then((r) => {
        if (r.status === 403) {
          setForbidden(true);
          return null;
        }

        return r.ok ? r.json() : null;
      })
      .then((data) => data && setReport((data as { report: UsageReport }).report))
      .catch(() => undefined);

    fetch('/api/admin/gallery')
      .then((r) => (r.ok ? r.json() : { submissions: [] }))
      .then((data) => setSubmissions((data as { submissions: Submission[] }).submissions ?? []))
      .catch(() => undefined);

    fetch('/api/admin/reports')
      .then((r) => (r.ok ? r.json() : { reports: [] }))
      .then((data) => setReports((data as { reports: Report[] }).reports ?? []))
      .catch(() => undefined);

    fetch('/api/admin/template')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => data && setTemplate(data as TemplateState))
      .catch(() => undefined);
  };

  useEffect(load, []);

  /**
   * Promotion and rollback both re-point what EVERY new project mounts (§4.4), so they confirm first —
   * this is the one control on this tab whose blast radius is every future user, not one game.
   */
  const moveTemplatePin = async (body: { action: 'promote'; ref?: string } | { action: 'rollback'; sha: string }) => {
    setBusy(true);

    try {
      const r = await fetch('/api/admin/template', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = (await r.json()) as { ok?: boolean; pin?: TemplatePin; message?: string };

      if (!r.ok || !data.ok) {
        // A refused promotion leaves the pin exactly where it was — say so, rather than a bare "failed".
        toast.error(data.message ?? 'Could not move the template pin.');
        return;
      }

      toast.success(
        body.action === 'promote'
          ? `Promoted ${data.pin?.ref} → ${data.pin?.sha.slice(0, 8)}. New projects mount this.`
          : `Rolled back to ${data.pin?.sha.slice(0, 8)}.`,
      );
      load();
    } finally {
      setBusy(false);
    }
  };

  const curate = async (projectId: string, decision: 'approve' | 'reject') => {
    const r = await fetch('/api/admin/gallery', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId, decision }),
    });

    if (r.ok) {
      toast.success(decision === 'approve' ? 'Featured in the gallery.' : 'Rejected.');
      setSubmissions((s) => s.filter((x) => x.projectId !== projectId));
    }
  };

  const resolve = async (report: Report, action: 'unpublish' | 'dismiss') => {
    const r = await fetch('/api/admin/reports', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: report.id, projectId: report.projectId, action }),
    });

    if (r.ok) {
      toast.success(action === 'unpublish' ? 'Game unpublished.' : 'Report dismissed.');
      setReports((rs) => rs.filter((x) => x.id !== report.id));
    }
  };

  if (forbidden) {
    return <div className="p-4 text-sm text-bolt-elements-textSecondary">This section is for admins only.</div>;
  }

  return (
    <div className="flex flex-col gap-6 p-1">
      <section>
        <h3 className="text-sm font-semibold text-bolt-elements-textPrimary">Usage & cost</h3>
        {!report ? (
          <div className="mt-2 text-sm text-bolt-elements-textSecondary">Loading…</div>
        ) : (
          <>
            <div className="mt-2 grid grid-cols-2 sm:grid-cols-3 gap-2">
              <Stat label="Generations" value={report.generations.toLocaleString()} />
              <Stat label="Failure rate" value={`${(report.failureRate * 100).toFixed(1)}%`} />
              <Stat label="Credits charged" value={report.creditsCharged.toLocaleString()} />
              <Stat label="Raw cost" value={`$${report.rawCostUsd.toFixed(2)}`} />
              <Stat label="Cache hit rate" value={`${(report.cacheHitRate * 100).toFixed(1)}%`} />
              <Stat label="Avg duration" value={`${(report.avgDurationMs / 1000).toFixed(1)}s`} />
              {/*
               * Output is 5x input and decodes serially, so it is most of the bill AND most of the wall
               * clock. Density is the diagnostic: real text runs ~3.5-4 chars per output token, so a low
               * number means we paid decode rate for thinking and redrafts the user never saw.
               */}
              <Stat label="Output density" value={`${report.charsPerOutputToken.toFixed(1)} ch/tok`} />
              <Stat label="Silent output" value={`${report.silentStepOutputTokens.toLocaleString()} tok`} />
            </div>
            {report.byModel.length > 0 && (
              <div className="mt-3 text-xs text-bolt-elements-textSecondary">
                {report.byModel.map((m) => (
                  <div key={m.model} className="flex justify-between py-0.5">
                    <span>{m.model}</span>
                    <span>
                      {m.generations} gen · ${m.rawCostUsd.toFixed(2)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </section>

      <section>
        <h3 className="text-sm font-semibold text-bolt-elements-textPrimary">Gallery submissions</h3>
        {submissions.length === 0 ? (
          <div className="mt-2 text-sm text-bolt-elements-textSecondary">Nothing awaiting review.</div>
        ) : (
          <div className="mt-2 flex flex-col gap-2">
            {submissions.map((s) => (
              <div
                key={s.projectId}
                className="flex items-center gap-2 px-3 py-2 rounded-md border border-bolt-elements-borderColor"
              >
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-bolt-elements-textPrimary truncate">{s.title}</div>
                  {s.description && (
                    <div className="text-xs text-bolt-elements-textSecondary truncate">{s.description}</div>
                  )}
                </div>
                <a
                  className="i-ph:play text-bolt-elements-textSecondary"
                  href={`/play/${s.shareId}`}
                  target="_blank"
                  rel="noreferrer"
                  title="Preview"
                />
                <button
                  className="text-xs px-2 py-1 rounded bg-green-500/10 text-green-600 dark:text-green-400"
                  onClick={() => curate(s.projectId, 'approve')}
                >
                  Approve
                </button>
                <button
                  className="text-xs px-2 py-1 rounded bg-red-500/10 text-red-500"
                  onClick={() => curate(s.projectId, 'reject')}
                >
                  Reject
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      <section>
        <h3 className="text-sm font-semibold text-bolt-elements-textPrimary">Reported games</h3>
        {reports.length === 0 ? (
          <div className="mt-2 text-sm text-bolt-elements-textSecondary">No open reports.</div>
        ) : (
          <div className="mt-2 flex flex-col gap-2">
            {reports.map((rep) => (
              <div
                key={rep.id}
                className="flex items-center gap-2 px-3 py-2 rounded-md border border-bolt-elements-borderColor"
              >
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-bolt-elements-textPrimary truncate">
                    {rep.reason || '(no reason given)'}
                  </div>
                  <div className="text-xs text-bolt-elements-textTertiary">{rep.shareId}</div>
                </div>
                <a
                  className="i-ph:play text-bolt-elements-textSecondary"
                  href={`/play/${rep.shareId}`}
                  target="_blank"
                  rel="noreferrer"
                  title="View"
                />
                <button
                  className="text-xs px-2 py-1 rounded bg-red-500/10 text-red-500"
                  onClick={() => resolve(rep, 'unpublish')}
                >
                  Unpublish
                </button>
                <button
                  className="text-xs px-2 py-1 rounded bg-bolt-elements-background-depth-3 text-bolt-elements-textSecondary"
                  onClick={() => resolve(rep, 'dismiss')}
                >
                  Dismiss
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      {/*
       * Template pin (§4.4). This is the supply chain: whatever is pinned here is the code every new
       * project starts from. Promotion is the ONLY way a push to the starter repo reaches users, and
       * rollback is the way back — so both the current pin and its provenance are shown, never implied.
       */}
      <section>
        <h3 className="text-sm font-semibold text-bolt-elements-textPrimary">Starter template</h3>
        {!template ? (
          <div className="mt-2 text-sm text-bolt-elements-textSecondary">Loading…</div>
        ) : (
          <div className="mt-2 flex flex-col gap-2">
            <div className="text-xs text-bolt-elements-textTertiary">
              {template.repo} · snapshots in {template.storage}
            </div>

            {!template.pinningEnabled && (
              <div className="text-xs px-3 py-2 rounded-md bg-amber-500/10 text-amber-600">
                Pinning is disabled (TEMPLATE_PINNING_ENABLED=false) — new projects track live main.
              </div>
            )}

            <div className="flex items-center gap-2 px-3 py-2 rounded-md border border-bolt-elements-borderColor">
              <div className="flex-1 min-w-0">
                {template.pin ? (
                  <>
                    <div className="text-sm text-bolt-elements-textPrimary truncate">
                      {template.pin.ref} · {template.pin.sha.slice(0, 8)} · {template.pin.fileCount} files
                    </div>
                    <div className="text-xs text-bolt-elements-textTertiary">
                      pinned {new Date(template.pin.pinnedAt).toLocaleString()}
                      {template.pin.pinnedBy === 'auto' && ' · auto (never reviewed)'}
                    </div>
                  </>
                ) : (
                  <div className="text-sm text-bolt-elements-textSecondary">
                    No pin yet — the next new project fetches live and pins the result.
                  </div>
                )}
              </div>
              <button
                className="text-xs px-2 py-1 rounded bg-bolt-elements-background-depth-3 text-bolt-elements-textSecondary disabled:opacity-50"
                disabled={busy}
                onClick={() => {
                  if (confirm('Promote the latest starter commit? Every new project will mount it.')) {
                    void moveTemplatePin({ action: 'promote' });
                  }
                }}
              >
                Promote latest
              </button>
            </div>

            {template.snapshots
              .filter((s) => !s.active)
              .map((snap) => (
                <div
                  key={snap.sha}
                  className="flex items-center gap-2 px-3 py-2 rounded-md border border-bolt-elements-borderColor"
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-bolt-elements-textPrimary truncate">{snap.sha.slice(0, 8)}</div>
                    <div className="text-xs text-bolt-elements-textTertiary">
                      {snap.storedAt ? new Date(snap.storedAt).toLocaleString() : 'stored'} ·{' '}
                      {Math.round(snap.size / 1024)}KB
                    </div>
                  </div>
                  <button
                    className="text-xs px-2 py-1 rounded bg-red-500/10 text-red-500 disabled:opacity-50"
                    disabled={busy}
                    onClick={() => {
                      if (confirm(`Roll new projects back to ${snap.sha.slice(0, 8)}?`)) {
                        void moveTemplatePin({ action: 'rollback', sha: snap.sha });
                      }
                    }}
                  >
                    Roll back
                  </button>
                </div>
              ))}
          </div>
        )}
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-bolt-elements-borderColor px-3 py-2">
      <div className="text-xs text-bolt-elements-textTertiary">{label}</div>
      <div className="text-lg font-semibold text-bolt-elements-textPrimary">{value}</div>
    </div>
  );
}
