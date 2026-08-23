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
import { MarketPricesSection } from './MarketPricesSection';
import { AssetLibrarySection } from './AssetLibrarySection';

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
  markers: { forcedContinuation: number; unproductiveRescue: number; providerRetry: number; rescued: number };
  integrity: { turnsWithViolations: number; byInvariant: Record<string, number>; turnsWithReissues: number };
  media: { renders: number; creditsCharged: number; rawCostUsd: number };
  byModel: Array<{ model: string; generations: number; rawCostUsd: number }>;
}

/** The `/api/admin/usage` `vm` field — `admin/vm-report.ts`'s shape, verbatim (plan T12). */
interface VmReport {
  marks: number;
  sandboxes: number;
  vmHours: number;
  running: number;
  clamped: number;
  unattributedHours: number;
  windowStart?: number;
  windowEnd?: number;
  users: number;
  topUsers: Array<{ userId: string; vmHours: number; sandboxes: number; running: number }>;
}

/**
 * The `/api/admin/usage` `sandboxStatus` field — `sandbox/provider-status.ts`'s shape, verbatim.
 * CodeSandbox has NO credit-balance endpoint (verified 2026-07-29); these are the provider's own live
 * counters — the headroom that fails first — beside the VM-hours estimate that stands in for spend.
 */
interface SandboxRateWindow {
  limit: number;
  remaining: number;
  resetAt?: number;
}
interface SandboxStatus {
  requestsHourly: SandboxRateWindow | null;
  sandboxesHourly: SandboxRateWindow | null;
  concurrentVms: SandboxRateWindow | null;
  runningVms: Array<{
    id: string;
    specs?: { cpu?: number; memory?: number; storage?: number };
    creditBasis?: string;
    sessionStartedAt?: string;
    lastActiveAt?: string;
  }> | null;
  fleetCount: number | null;
  reason: string | null;
}
interface Submission {
  projectId: string;
  shareId: string;

  /** The public URL, minted server-side from `SHARE_DOMAIN`. Never built here. */
  url?: string;
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

/**
 * Whether the three **remote-VM provider** sections are shown (hide-don't-delete, §4.1a):
 * *Sandbox template*, *Sandbox VM time* and *CodeSandbox status*.
 *
 * 🔴 All three describe machinery that exists only when a VM provider is running. Nodepod runs in the
 * user's own browser: it mints no VM, forks no template, bills no VM-hour and has no rate limit to
 * report. So the template panel promotes nothing, the status panel reads "not configured", and the
 * VM-time panel is the dangerous one — **it renders the CodeSandbox era's historical marks in the
 * PRESENT tense.** Observed on this deploy: *491.8 VM hours · Running now 16*, when the true answer
 * is zero and can never be anything else. That is a false number on the one panel an operator reads
 * to answer "what is production costing me right now".
 *
 * ⚠️ **An admin control that describes machinery the running provider does not use is worse than a
 * missing one.** A dead lever reads as a lever you have; a stale gauge reads as a live measurement.
 * Same reasoning as the inherited Settings toggles that only wired to the fail-closed `/api/chat`.
 *
 * ONE flag, not three, because they are one story — flip to CodeSandbox and you want all three back
 * together, and three booleans a few lines apart is how two of them end up disagreeing.
 *
 * Kept, not deleted: the routes, the mark store, the pin logic and the report builders are all live
 * and correct, and CodeSandbox is still selectable via `VITE_SANDBOX_PROVIDER`.
 *
 * ⚠️ This gates the RENDER, and the sandbox-template FETCH (its own route, so skipping it is free).
 * It deliberately does NOT gate `/api/admin/usage` — that one call also carries the usage/cost report
 * and the provider balance, which are provider-independent and still wanted.
 */
const SHOW_VM_PROVIDER_PANELS = false;

/** The `/api/admin/sandbox-template` payload — `sandbox/template-pin.ts`'s shapes, verbatim (plan T14). */
interface SandboxTemplatePin {
  target: string;
  promotedAt: string;
  promotedBy: 'promote' | 'rollback';
  provenance?: string;
}
interface SandboxTemplateState {
  configured: boolean;
  pin: SandboxTemplatePin | null;
  history: SandboxTemplatePin[];
  live: string;
  effective: 'pin' | 'env' | 'default';
  baked: string;
}
interface PromptState {
  summary: {
    reference: { repo: string; commitSha: string; syncedAt: string } | null;
    skills: { repo: string; count: number; commitSha: string | null };
  };
}

/**
 * The provider credit pool, as `/api/admin/usage` returns it — the server's shape, verbatim
 * (`billing/provider-balance.ts`). Declared here rather than imported because that module is
 * `.server` only: it reads `KIE_API_KEY`, and a client import would pull the key's reader into the
 * browser bundle (§5).
 */
interface ProviderBalance {
  credits: number | null;
  usd: number | null;
  platformCreditsRemaining: number | null;
  creditsPerUsd: number;
  fetchedAt: string;
  reason?: string;
}

/** The `/api/admin/refunds` report — the server's shapes, verbatim (`admin/refund-report.ts`). */
interface RefundReport {
  refunds: number;
  creditsRefunded: number;
  rawCostEatenUsd: number;
  unjoined: number;
  refundRate: number;
  sampledGenerations: number;
  byKind: Record<'generation' | 'media' | 'other', { refunds: number; credits: number }>;
  byCause: Array<{ cause: string; refunds: number; credits: number }>;
  rows: Array<{
    id: string;
    createdAt: string;
    userId: string;
    credits: number;
    kind: string;
    generationId?: string;
    model?: string;
    cause: string;
    rawCostUsd?: number;
  }>;
}

export function AdminTab() {
  const [forbidden, setForbidden] = useState(false);
  const [report, setReport] = useState<UsageReport | null>(null);
  const [refunds, setRefunds] = useState<RefundReport | null>(null);
  const [refundsHaveMore, setRefundsHaveMore] = useState(false);
  const [refundRows, setRefundRows] = useState<RefundReport['rows']>([]);
  const [submissions, setSubmissions] = useState<Submission[]>([]);
  const [reports, setReports] = useState<Report[]>([]);
  const [template, setTemplate] = useState<TemplateState | null>(null);
  const [sandboxTemplate, setSandboxTemplate] = useState<SandboxTemplateState | null>(null);
  const [prompt, setPrompt] = useState<PromptState | null>(null);
  const [providerBalance, setProviderBalance] = useState<ProviderBalance | null>(null);

  /**
   * `null` is a REAL state here, not "loading": the usage route returns `vm: null` when the mark
   * store could not be read, and rendering "unavailable" is the honest answer. A spinner would
   * promise a number that is never coming.
   */
  const [vm, setVm] = useState<VmReport | null>(null);
  const [vmLoaded, setVmLoaded] = useState(false);
  const [sandboxStatus, setSandboxStatus] = useState<SandboxStatus | null>(null);
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
      .then((data) => {
        if (!data) {
          return;
        }

        const payload = data as {
          report: UsageReport;
          providerBalance?: ProviderBalance;
          vm?: VmReport | null;
          sandboxStatus?: SandboxStatus | null;
        };
        setReport(payload.report);
        setProviderBalance(payload.providerBalance ?? null);
        setVm(payload.vm ?? null);
        setSandboxStatus(payload.sandboxStatus ?? null);
        setVmLoaded(true);
      })
      .catch(() => undefined);

    fetch('/api/admin/refunds')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data) {
          return;
        }

        const payload = data as { report: RefundReport; hasMore: boolean };

        // Page one owns the SUMMARY; deeper pages only ever append rows (loadMoreRefunds below).
        setRefunds(payload.report);
        setRefundRows(payload.report.rows);
        setRefundsHaveMore(payload.hasMore);
      })
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

    fetch('/api/admin/prompt')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => data && setPrompt(data as PromptState))
      .catch(() => undefined);

    if (SHOW_VM_PROVIDER_PANELS) {
      fetch('/api/admin/sandbox-template')
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => data && setSandboxTemplate(data as SandboxTemplateState))
        .catch(() => undefined);
    }
  };

  useEffect(load, []);

  /**
   * Page deeper into the refund history — the summary stays page one's (it describes the most recent
   * window); only the ROWS accumulate, so "see them all" never re-aggregates a moving target.
   */
  const loadMoreRefunds = async () => {
    setBusy(true);

    try {
      const r = await fetch(`/api/admin/refunds?offset=${refundRows.length}`);

      if (!r.ok) {
        return;
      }

      const data = (await r.json()) as { report: RefundReport; hasMore: boolean };
      setRefundRows((rows) => [...rows, ...data.report.rows]);
      setRefundsHaveMore(data.hasMore);
    } catch {
      // A failed page leaves what is already shown; the button stays for a retry.
    } finally {
      setBusy(false);
    }
  };

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

  /**
   * Move the SANDBOX template pin (plan T14) — the VM every new project forks.
   *
   * Same blast radius as the starter-template pin above and the same posture, with one addition worth
   * saying out loud in the UI: a promotion validates by forking the candidate for real, so a refusal
   * here means the template genuinely did not come up, not that a check was fussy.
   */
  const moveSandboxTemplate = async (body: { action: 'promote' | 'rollback'; target: string; provenance?: string }) => {
    setBusy(true);

    try {
      const r = await fetch('/api/admin/sandbox-template', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = (await r.json()) as { ok?: boolean; pin?: SandboxTemplatePin; message?: string };

      if (!r.ok || !data.ok) {
        // A refused promotion leaves the pin exactly where it was — say so, and say why it was refused.
        toast.error(data.message ?? 'Could not move the sandbox template pin.');
        return;
      }

      toast.success(
        body.action === 'promote'
          ? `Promoted ${data.pin?.target}. New projects fork this.`
          : `Rolled back to ${data.pin?.target}.`,
      );
      load();
    } finally {
      setBusy(false);
    }
  };

  /**
   * Sync the Agent Reference (docs) + skills repos and rebuild the system prompt (§4.3, §4.11). This
   * is the supply chain to the MODEL — the docs/skills equivalent of promoting the starter template.
   * A failed build leaves the previous version live (the route's guarantee), so a broken push can
   * never take generation down; we report which commits are now live, or why nothing changed.
   */
  const refreshDocs = async () => {
    setBusy(true);

    try {
      const r = await fetch('/api/admin/prompt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'refresh' }),
      });
      const data = (await r.json()) as {
        ok?: boolean;
        status?: string;
        agentCommitSha?: string;
        skills?: { commitSha?: string };
        message?: string;
      };

      if (!r.ok || !data.ok) {
        toast.error(data.message ?? 'Refresh failed — the previous version stays live.');
        return;
      }

      const docs = data.agentCommitSha?.slice(0, 8) ?? '?';
      const skills = data.skills?.commitSha?.slice(0, 8) ?? '?';
      toast.success(
        data.status === 'unchanged'
          ? `Already current — docs @ ${docs}, skills @ ${skills}.`
          : `Live now — docs @ ${docs}, skills @ ${skills}.`,
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
      {/*
       * The provider pool every user's generation draws from (§4.10). The ledger says what users owe
       * US; this says what WE have left with KIE — and when it hits zero the product stops for
       * everybody at once, which nothing else on this page would show.
       */}
      <section>
        <h3 className="text-sm font-semibold text-bolt-elements-textPrimary">Provider credit pool</h3>
        {!providerBalance ? (
          <div className="mt-2 text-sm text-bolt-elements-textSecondary">Loading…</div>
        ) : providerBalance.credits === null ? (
          <div className="mt-2 px-3 py-2 rounded-md border border-bolt-elements-borderColor text-sm text-bolt-elements-textSecondary">
            <span className="text-bolt-elements-textPrimary font-medium">Balance unknown</span>
            {providerBalance.reason ? ` — ${providerBalance.reason}` : null}
          </div>
        ) : (
          <>
            <div className="mt-2 grid grid-cols-2 sm:grid-cols-3 gap-2">
              <Stat label="KIE credits left" value={Math.floor(providerBalance.credits).toLocaleString()} />
              <Stat
                label="Approx. value"
                value={providerBalance.usd === null ? '—' : `$${providerBalance.usd.toFixed(2)}`}
              />
              {/*
               * The runway number: not "how much money is left" but "how much PRODUCT is left" —
               * derived from the same unit cost and margin the biller charges by, so it cannot drift
               * away from real pricing.
               */}
              <Stat
                label="Serves ≈ platform credits"
                value={
                  providerBalance.platformCreditsRemaining === null
                    ? '—'
                    : providerBalance.platformCreditsRemaining.toLocaleString()
                }
              />
            </div>
            <div className="mt-1 text-xs text-bolt-elements-textTertiary">
              {`Dollar and platform-credit figures are estimates at ${providerBalance.creditsPerUsd} KIE credits per $1 (measured 2026-07-26). Read ${new Date(providerBalance.fetchedAt).toLocaleTimeString()}.`}
            </div>
          </>
        )}
      </section>

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
              {/*
               * The rescues, made visible (spec/fail-loud.md Stage C). Each one WORKED — the user got
               * their artifact — which is exactly why nothing else on this page would ever show them.
               * A rising number means the cause is upstream of the rescue and the rescue is only
               * paying for it, at 5x output rate, since every one is a second stream.
               */}
              <Stat
                label="Rescued turns"
                value={
                  report.generations
                    ? `${report.markers.rescued} (${((report.markers.rescued / report.generations) * 100).toFixed(1)}%)`
                    : '0'
                }
              />
            </div>
            {report.markers.rescued > 0 && (
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-bolt-elements-textSecondary">
                <span>Forced continuation: {report.markers.forcedContinuation}</span>
                <span>Unproductive rescue: {report.markers.unproductiveRescue}</span>
                <span>Provider retry: {report.markers.providerRetry}</span>
              </div>
            )}
            {/*
             * Media spend, beside the generation numbers rather than inside them. `med_*` rows share
             * the `generations` table but are not model turns, so folding them into the counters above
             * dilutes every one of them — and excluding them WITHOUT this row made real KIE money
             * vanish from a section headed "Usage & cost".
             */}
            {report.media?.renders > 0 && (
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-bolt-elements-textSecondary">
                <span>Media renders: {report.media.renders}</span>
                <span>Media credits: {report.media.creditsCharged.toLocaleString()}</span>
                <span>Media raw cost: ${report.media.rawCostUsd.toFixed(2)}</span>
              </div>
            )}
            {/*
             * 🔴 RENDERED WHENEVER THE REPORT CARRIES THE FIELD, not only when something is wrong.
             *
             * Hiding a zero makes "the platform is healthy" and "the verifier never ran" look identical
             * on screen — and this report cannot distinguish "never checked" from "checked and clean"
             * either, so an operator would have no way to tell. An integrity counter that disappears
             * when the integrity check is dead is `spec/fail-loud.md` rule 9 one level up: a metric that
             * reports success on the failure it does not expect.
             */}
            {report.integrity && (
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-bolt-elements-textSecondary">
                <span>Request mismatches: {report.integrity.turnsWithViolations}</span>
                <span>Turns that re-issued: {report.integrity.turnsWithReissues}</span>
                {Object.entries(report.integrity.byInvariant).map(([id, count]) => (
                  <span key={id}>
                    {id}: {count}
                  </span>
                ))}
              </div>
            )}
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

      {/*
       * Sandbox VM time (plan T12). The launch decision was to BAKE VM compute into the margin rather
       * than meter it (`billing/vm-cost.ts`), which is only defensible while somebody checks the
       * estimate that decision rests on. This section is that check — and the number that would
       * eventually justify building metering, if one account's hours ever stop looking like everyone's.
       *
       * Hidden while the browser-side provider is the one running — see {@link SHOW_VM_PROVIDER_PANELS}.
       */}
      {SHOW_VM_PROVIDER_PANELS && (
        <section>
          <h3 className="text-sm font-semibold text-bolt-elements-textPrimary">Sandbox VM time</h3>
          {!vmLoaded ? (
            <div className="mt-2 text-sm text-bolt-elements-textSecondary">Loading…</div>
          ) : !vm ? (
            <div className="mt-2 px-3 py-2 rounded-md border border-bolt-elements-borderColor text-sm text-bolt-elements-textSecondary">
              <span className="text-bolt-elements-textPrimary font-medium">Unavailable</span> — the lifecycle mark store
              could not be read. Usage and cost above are unaffected.
            </div>
          ) : (
            <>
              <div className="mt-2 grid grid-cols-2 sm:grid-cols-3 gap-2">
                <Stat label="VM hours" value={vm.vmHours.toFixed(1)} />
                <Stat label="Running now" value={vm.running.toLocaleString()} />
                <Stat label="Sandboxes seen" value={vm.sandboxes.toLocaleString()} />
                <Stat label="Accounts" value={vm.users.toLocaleString()} />
                <Stat label="Lifecycle marks" value={vm.marks.toLocaleString()} />
                <Stat label="Unattributed" value={`${vm.unattributedHours.toFixed(1)} h`} />
              </div>
              {/*
               * The accuracy warning, not a footnote: the provider hibernates an idle VM on its own
               * timeout and never tells us, so those intervals get clamped rather than measured. A count
               * approaching "running now" means these hours are a ceiling.
               */}
              {vm.clamped > 0 && (
                <div className="mt-2 text-xs text-bolt-elements-textTertiary">
                  {`${vm.clamped} open interval(s) hit the 24h ceiling — the provider's own idle hibernation writes no closing mark, so those hours are an upper bound.`}
                </div>
              )}
              {vm.topUsers.length > 0 && (
                <div className="mt-3 text-xs text-bolt-elements-textSecondary">
                  {vm.topUsers.map((u) => (
                    <div key={u.userId} className="flex justify-between py-0.5">
                      <span className="font-mono">{u.userId}</span>
                      <span>
                        {u.vmHours.toFixed(1)} h · {u.sandboxes} VM{u.sandboxes === 1 ? '' : 's'}
                        {u.running > 0 ? ` · ${u.running} running` : ''}
                      </span>
                    </div>
                  ))}
                </div>
              )}
              {vm.marks === 0 && (
                <div className="mt-2 text-xs text-bolt-elements-textTertiary">
                  No lifecycle marks recorded yet. This is empty until a project opens a sandbox.
                </div>
              )}
            </>
          )}
        </section>
      )}

      {/*
       * CodeSandbox status (2026-07-29). Their API has NO credit-balance endpoint (verified against
       * the full REST surface — the spend estimate is the VM-hours section above × the Pico rate), so
       * this shows the provider's own live counters instead: the three rate-limit gauges (hourly API
       * requests is the cap that bites first — 3,600/hr; hourly creations is the platform's whole
       * fork budget), the VMs burning credits right now, and the fleet count the orphan sweep audits.
       *
       * Hidden while the browser-side provider is the one running — see {@link SHOW_VM_PROVIDER_PANELS}.
       */}
      {SHOW_VM_PROVIDER_PANELS && (
        <section>
          <h3 className="text-sm font-semibold text-bolt-elements-textPrimary">CodeSandbox status</h3>
          {!vmLoaded ? (
            <div className="mt-2 text-sm text-bolt-elements-textSecondary">Loading…</div>
          ) : !sandboxStatus ||
            (!sandboxStatus.requestsHourly && !sandboxStatus.concurrentVms && !sandboxStatus.fleetCount) ? (
            <div className="mt-2 px-3 py-2 rounded-md border border-bolt-elements-borderColor text-sm text-bolt-elements-textSecondary">
              <span className="text-bolt-elements-textPrimary font-medium">Unavailable</span>
              {sandboxStatus?.reason ? ` — ${sandboxStatus.reason}` : ' — the provider could not be read.'} Usage and
              cost above are unaffected.
            </div>
          ) : (
            <>
              <div className="mt-2 grid grid-cols-2 sm:grid-cols-3 gap-2">
                <Stat
                  label="API requests left (this hour)"
                  value={
                    sandboxStatus.requestsHourly
                      ? `${sandboxStatus.requestsHourly.remaining.toLocaleString()} / ${sandboxStatus.requestsHourly.limit.toLocaleString()}`
                      : '—'
                  }
                />
                <Stat
                  label="Sandbox creations left (this hour)"
                  value={
                    sandboxStatus.sandboxesHourly
                      ? `${sandboxStatus.sandboxesHourly.remaining} / ${sandboxStatus.sandboxesHourly.limit}`
                      : '—'
                  }
                />
                <Stat
                  label="Concurrent VMs"
                  value={
                    sandboxStatus.concurrentVms
                      ? `${sandboxStatus.concurrentVms.limit - sandboxStatus.concurrentVms.remaining} of ${sandboxStatus.concurrentVms.limit}`
                      : '—'
                  }
                />
                <Stat
                  label="Running now"
                  value={sandboxStatus.runningVms === null ? '—' : sandboxStatus.runningVms.length.toLocaleString()}
                />
                <Stat
                  label="Fleet (btk sandboxes)"
                  value={sandboxStatus.fleetCount === null ? '—' : sandboxStatus.fleetCount.toLocaleString()}
                />
              </div>
              {sandboxStatus.runningVms !== null && sandboxStatus.runningVms.length > 0 && (
                <div className="mt-3 text-xs text-bolt-elements-textSecondary">
                  {sandboxStatus.runningVms.map((v) => (
                    <div key={v.id} className="flex justify-between py-0.5">
                      <span className="font-mono">{v.id}</span>
                      <span>
                        {v.specs ? `${v.specs.cpu ?? '?'} vCPU · ${v.specs.memory ?? '?'}GB` : 'specs unknown'}
                        {v.sessionStartedAt ? ` · up since ${new Date(v.sessionStartedAt).toLocaleTimeString()}` : ''}
                      </span>
                    </div>
                  ))}
                </div>
              )}
              {sandboxStatus.reason && (
                <div className="mt-2 text-xs text-bolt-elements-textTertiary">{`Partial read: ${sandboxStatus.reason}`}</div>
              )}
              <div className="mt-2 text-xs text-bolt-elements-textTertiary">
                CodeSandbox exposes no credit balance — estimated spend is the VM hours above × the configured hourly
                rate; the balance itself lives in their dashboard.
              </div>
            </>
          )}
        </section>
      )}

      {/*
       * Refund audit (§4.10, spec/fail-loud.md). Every refund is money the OPERATOR ate — the provider
       * billed us, the user got their credits back — so this section answers "am I refunding people,
       * and why?" without a database console. Zero refunds is a real answer and renders as one.
       */}
      <section>
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-bolt-elements-textPrimary">Refund audit</h3>
          {/* The COMPLETE audit — every refund ever, not the panel's window — in spreadsheet form. */}
          {refunds && refunds.refunds > 0 && (
            <a
              href="/api/admin/refunds?format=csv"
              download
              className="text-xs px-2 py-1 rounded bg-bolt-elements-background-depth-3 text-bolt-elements-textSecondary hover:bg-bolt-elements-item-backgroundActive"
            >
              Download all (CSV)
            </a>
          )}
        </div>
        {!refunds ? (
          <div className="mt-2 text-sm text-bolt-elements-textSecondary">Loading…</div>
        ) : refunds.refunds === 0 ? (
          <p className="mt-2 text-sm text-bolt-elements-textSecondary">
            No refunds recorded — across {refunds.sampledGenerations.toLocaleString()} sampled generations, nothing has
            been refunded.
          </p>
        ) : (
          <>
            <div className="mt-2 grid grid-cols-2 sm:grid-cols-4 gap-2">
              <Stat label="Refunds" value={refunds.refunds.toLocaleString()} />
              <Stat label="Refund rate" value={`${(refunds.refundRate * 100).toFixed(1)}%`} />
              <Stat label="Credits refunded" value={refunds.creditsRefunded.toLocaleString()} />
              {/* A lower bound: refunds we could not join to a generation contribute nothing here. */}
              <Stat label="Cost eaten" value={`$${refunds.rawCostEatenUsd.toFixed(2)}`} />
            </div>

            <div className="mt-2 flex gap-3 text-xs text-bolt-elements-textTertiary">
              {(['generation', 'media', 'other'] as const).map(
                (kind) =>
                  refunds.byKind[kind].refunds > 0 && (
                    <span key={kind}>
                      {kind}: {refunds.byKind[kind].refunds} ({refunds.byKind[kind].credits.toLocaleString()} cr)
                    </span>
                  ),
              )}
              {refunds.unjoined > 0 && <span>· {refunds.unjoined} without a generation record</span>}
            </div>

            {/* The "what do I fix" list — same failure grouped despite differing numbers in the message. */}
            {refunds.byCause.length > 0 && (
              <div className="mt-3">
                <p className="text-[10px] text-bolt-elements-textTertiary uppercase tracking-wide">Top causes</p>
                {refunds.byCause.slice(0, 6).map((bucket) => (
                  <div key={bucket.cause} className="flex justify-between gap-3 py-0.5 text-xs">
                    <span className="truncate text-bolt-elements-textSecondary" title={bucket.cause}>
                      {bucket.cause}
                    </span>
                    <span className="shrink-0 text-bolt-elements-textPrimary">
                      {bucket.refunds}× · {bucket.credits.toLocaleString()} cr
                    </span>
                  </div>
                ))}
              </div>
            )}

            <div className="mt-3">
              <p className="text-[10px] text-bolt-elements-textTertiary uppercase tracking-wide">
                Refunds ({refundRows.length.toLocaleString()} loaded{refundsHaveMore ? ', more available' : ' — all'})
              </p>
              <div className="max-h-56 overflow-y-auto">
                {refundRows.map((row) => (
                  <div
                    key={row.id}
                    className="flex items-baseline justify-between gap-3 py-1 text-xs border-b border-bolt-elements-borderColor/50 last:border-0"
                    title={`${row.generationId ?? 'no generation id'} — user ${row.userId}`}
                  >
                    <span className="truncate text-bolt-elements-textSecondary">
                      <span className="text-bolt-elements-textPrimary">{row.credits.toLocaleString()} cr</span>
                      {' · '}
                      {row.kind}
                      {row.model ? ` · ${row.model}` : ''}
                      {' · '}
                      <span title={row.cause}>{row.cause.length > 60 ? `${row.cause.slice(0, 60)}…` : row.cause}</span>
                    </span>
                    <span className="shrink-0 text-bolt-elements-textTertiary">
                      {new Date(row.createdAt).toLocaleString()}
                    </span>
                  </div>
                ))}
              </div>
              {refundsHaveMore && (
                <button
                  className="mt-1 text-xs px-2 py-1 rounded bg-bolt-elements-background-depth-3 text-bolt-elements-textSecondary hover:bg-bolt-elements-item-backgroundActive disabled:opacity-50"
                  disabled={busy}
                  onClick={() => void loadMoreRefunds()}
                >
                  {busy ? 'Loading…' : 'Load 200 more'}
                </button>
              )}
            </div>
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
                {/* `url` is server-minted (`api.admin.gallery`) — a curator previews the real public URL. */}
                <a
                  className="i-ph:play text-bolt-elements-textSecondary"
                  href={s.url}
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
                {/*
                 * The PLATFORM route, not a minted share URL: a report carries only a share id (it is
                 * filed anonymously against `play_reports`), and resolving each one to a project just to
                 * pretty up an admin link is a lookup per row for no benefit. `/app/:id` 301s to the
                 * canonical address in production, so this lands in the right place either way.
                 */}
                <a
                  className="i-ph:play text-bolt-elements-textSecondary"
                  href={`/app/${rep.shareId}`}
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
       * Agent properties (§4.3, §4.11). The supply chain to the MODEL: whatever is live here is the
       * knowledge every generation is built from. TWO labeled rows (docs vs skills, each keyed to the
       * commit that is live), ONE Synchronize button — because doc-sync rebuilds both together, and a
       * failed build leaves the current version live (the route's guarantee).
       */}
      <section>
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-bolt-elements-textPrimary">Agent repository</h3>
          <button
            className="text-xs px-2 py-1 rounded bg-bolt-elements-background-depth-3 text-bolt-elements-textSecondary disabled:opacity-50"
            disabled={busy || !prompt}
            onClick={() => {
              if (
                confirm('Sync the Agent Reference + Skills from GitHub and rebuild the prompt? Goes live on success.')
              ) {
                void refreshDocs();
              }
            }}
          >
            {busy ? 'Synchronizing…' : 'Synchronize'}
          </button>
        </div>
        {!prompt ? (
          <div className="mt-2 text-sm text-bolt-elements-textSecondary">Loading…</div>
        ) : (
          <div className="mt-2 flex flex-col gap-2">
            <InfoRow
              label="Agent Reference"
              detail={
                prompt.summary.reference
                  ? `${prompt.summary.reference.repo} · commit ${prompt.summary.reference.commitSha.slice(0, 8)} · ` +
                    `synced ${new Date(prompt.summary.reference.syncedAt).toLocaleString()}`
                  : 'Not synced yet — click Synchronize.'
              }
            />
            <InfoRow
              label="Agent Skills"
              detail={
                `${prompt.summary.skills.repo} · ${prompt.summary.skills.count} skill` +
                `${prompt.summary.skills.count === 1 ? '' : 's'}` +
                `${prompt.summary.skills.commitSha ? ` · commit ${prompt.summary.skills.commitSha.slice(0, 8)}` : ''}`
              }
            />
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
                Promote
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

      {/*
       * Sandbox template pin (plan T14) — §4.4's pin-and-promote applied to the RUNTIME. Sibling of
       * "Starter template" above and deliberately next to it: one decides the files a new project gets,
       * the other decides the machine they land on, and both are supply-chain decisions.
       *
       * Hidden while the browser-side provider is the one running — see {@link SHOW_VM_PROVIDER_PANELS}.
       */}
      {SHOW_VM_PROVIDER_PANELS && (
        <section>
          <h3 className="text-sm font-semibold text-bolt-elements-textPrimary">Sandbox template</h3>
          {!sandboxTemplate ? (
            <div className="mt-2 text-sm text-bolt-elements-textSecondary">Loading…</div>
          ) : (
            <div className="mt-2 flex flex-col gap-2">
              <div className="text-xs text-bolt-elements-textTertiary">
                New projects fork <span className="font-mono">{sandboxTemplate.live}</span> ({sandboxTemplate.effective}
                {sandboxTemplate.effective === 'default' ? ` — ${sandboxTemplate.baked}` : ''})
              </div>

              {!sandboxTemplate.configured && (
                <div className="text-xs px-3 py-2 rounded-md bg-amber-500/10 text-amber-600">
                  CodeSandbox is not configured on this deploy — promoting is unavailable.
                </div>
              )}

              <div className="flex items-center gap-2 px-3 py-2 rounded-md border border-bolt-elements-borderColor">
                <div className="flex-1 min-w-0">
                  {sandboxTemplate.pin ? (
                    <>
                      <div className="text-sm text-bolt-elements-textPrimary truncate font-mono">
                        {sandboxTemplate.pin.target}
                      </div>
                      <div className="text-xs text-bolt-elements-textTertiary truncate">
                        {sandboxTemplate.pin.promotedBy} {new Date(sandboxTemplate.pin.promotedAt).toLocaleString()}
                        {sandboxTemplate.pin.provenance ? ` · ${sandboxTemplate.pin.provenance}` : ''}
                      </div>
                    </>
                  ) : (
                    <div className="text-sm text-bolt-elements-textSecondary">
                      Nothing promoted — new projects fork whatever the alias points at today.
                    </div>
                  )}
                </div>
                <button
                  className="text-xs px-2 py-1 rounded bg-bolt-elements-background-depth-3 text-bolt-elements-textSecondary disabled:opacity-50"
                  disabled={busy || !sandboxTemplate.configured}
                  onClick={() => {
                    /*
                     * A promotion re-points what EVERY new project boots from, and validating it forks a
                     * real VM — so it asks for the target by name rather than guessing one, and confirms
                     * before spending.
                     */
                    // `window.` is required: `prompt` is this component's own state (the docs/skills panel).
                    const target = window.prompt('Template id or alias to promote (e.g. btk@starter):');

                    if (target?.trim()) {
                      void moveSandboxTemplate({
                        action: 'promote',
                        target: target.trim(),
                        provenance:
                          window.prompt('What is this build? (optional note for the history)')?.trim() || undefined,
                      });
                    }
                  }}
                >
                  Promote…
                </button>
              </div>

              {sandboxTemplate.history
                .filter((entry) => entry.target !== sandboxTemplate.pin?.target)
                .map((entry) => (
                  <div
                    key={entry.target}
                    className="flex items-center gap-2 px-3 py-2 rounded-md border border-bolt-elements-borderColor"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-bolt-elements-textPrimary truncate font-mono">{entry.target}</div>
                      <div className="text-xs text-bolt-elements-textTertiary truncate">
                        {new Date(entry.promotedAt).toLocaleString()}
                        {entry.provenance ? ` · ${entry.provenance}` : ''}
                      </div>
                    </div>
                    <button
                      className="text-xs px-2 py-1 rounded bg-red-500/10 text-red-500 disabled:opacity-50"
                      disabled={busy}
                      onClick={() => {
                        if (confirm(`Roll new projects back to ${entry.target}?`)) {
                          void moveSandboxTemplate({ action: 'rollback', target: entry.target });
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
      )}

      {/*
       * Asset library (§4.4d). The Synty prototype manifest the model is told about — versioned +
       * promoted here from the master at repo.babylontoolkit.com, never fetched at generation time.
       */}
      <AssetLibrarySection />

      {/*
       * Marketplace prices (§4.6). The platform's cost basis — what we believe KIE charges for LLM
       * tokens and media generation. Versioned + promoted here; the env price vars are retired.
       */}
      <MarketPricesSection />
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

/** A labeled one-line status row (docs / skills), styled like the Starter template pin line. */
function InfoRow({ label, detail }: { label: string; detail: string }) {
  return (
    <div className="px-3 py-2 rounded-md border border-bolt-elements-borderColor">
      <div className="text-sm text-bolt-elements-textPrimary">{label}</div>
      <div className="text-xs text-bolt-elements-textTertiary truncate">{detail}</div>
    </div>
  );
}
