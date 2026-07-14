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
  estimatedWastedOutputTokens: number;
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

export function AdminTab() {
  const [forbidden, setForbidden] = useState(false);
  const [report, setReport] = useState<UsageReport | null>(null);
  const [submissions, setSubmissions] = useState<Submission[]>([]);
  const [reports, setReports] = useState<Report[]>([]);

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
  };

  useEffect(load, []);

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
              <Stat label="Wasted output" value={`${report.estimatedWastedOutputTokens.toLocaleString()} tok`} />
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
