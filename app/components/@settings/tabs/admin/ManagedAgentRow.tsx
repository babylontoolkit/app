/**
 * Managed agent provisioning (`_specs/managed-agents-engine_plan.md` T3, T12) — one row under Agent
 * repository, beside Synchronize, listing one agent per model tier (Standard / Premium / Platinum, §4.6.1a —
 * a session's model is fixed, so each rung the user can pick is its own provisioned agent). Synchronize builds the prompt version AND provisions the managed agent
 * from it (T12); this button is the manual / retry path. Re-pressing with nothing changed is a no-op on
 * the server (hash-skipped), so the button is safe to press.
 */
import { useEffect, useState } from 'react';
import { toast } from 'react-toastify';

interface AgentSummary {
  agentId: string;
  agentVersion: number;
  referenceSha: string;
  referenceFiles: number;
  skills: string[];
  provisionedAt: string;
}

interface TierAgent {
  tier: string;
  label: string;
  model: string;
  key: string;
  current: boolean;
  agent: AgentSummary | null;
}

interface ManagedAgentState {
  configured: boolean;
  engine?: string;
  message?: string;
  key?: string;
  current?: boolean;
  agent?: AgentSummary | null;
  tiers?: TierAgent[];
}

interface TierProvisionLine {
  label: string;
  model: string;
  status?: string;
  agentId?: string;
  agentVersion?: number;
  error?: string;
}

function tierLine(row: TierAgent): string {
  if (!row.agent) {
    return `${row.label} · ${row.model} — not provisioned (it is provisioned on its first turn, or press the button)`;
  }

  return (
    `${row.label} · ${row.model} — ${row.agent.agentId} v${row.agent.agentVersion}` +
    (row.current ? '' : ' · from an earlier prompt version — provision to update')
  );
}

/** `reloadSignal` changes after a Synchronize (which provisions server-side) so the row re-reads its state. */
export function ManagedAgentRow({ reloadSignal = 0 }: { reloadSignal?: number }) {
  const [state, setState] = useState<ManagedAgentState | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => {
    fetch('/api/admin/managed-agent')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => data && setState(data as ManagedAgentState))
      .catch(() => undefined);
  };

  useEffect(load, [reloadSignal]);

  const provision = async () => {
    setBusy(true);

    try {
      const r = await fetch('/api/admin/managed-agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'provision' }),
      });
      const data = (await r.json()) as {
        ok?: boolean;
        status?: string;
        agentId?: string;
        agentVersion?: number;
        message?: string;
        tiers?: TierProvisionLine[];
      };

      if (r.status === 503) {
        toast.error(`Not configured: ${data.message ?? 'the managed agent engine is not configured.'}`);
        return;
      }

      if (!r.ok || !data.ok) {
        toast.error(data.message ?? 'Provisioning failed.');
        load();

        return;
      }

      const failed = (data.tiers ?? []).filter((row) => row.error);

      for (const row of failed) {
        toast.error(`${row.label} agent (${row.model}) was not provisioned: ${row.error}`);
      }

      const done = (data.tiers ?? []).filter((row) => !row.error);
      const changed = done.filter((row) => row.status !== 'unchanged');

      toast.success(
        changed.length === 0
          ? `All ${done.length} model tier agent${done.length === 1 ? '' : 's'} already current.`
          : `Provisioned: ${changed.map((row) => `${row.label} (${row.status})`).join(', ')}.`,
      );
      load();
    } finally {
      setBusy(false);
    }
  };

  let detail: string;
  let lines: string[] = [];

  if (!state) {
    detail = 'Loading…';
  } else if (!state.configured) {
    detail = `Not configured: ${state.message ?? ''}`;
  } else if (!state.agent) {
    detail = `Not provisioned (${state.key}) — press Synchronize (it provisions) or Provision managed agents.`;
  } else {
    const a = state.agent;
    detail =
      `docs ${a.referenceSha.slice(0, 8)} (${a.referenceFiles} files) · ` +
      `${a.skills.length} skill${a.skills.length === 1 ? '' : 's'}` +
      (state.engine === 'managed' ? '' : ' · engine: legacy');
    lines = (state.tiers ?? []).map(tierLine);
  }

  return (
    <div className="flex items-start gap-3 px-3 py-2 rounded-md border border-bolt-elements-borderColor">
      <div className="flex-1 min-w-0">
        <div className="text-sm text-bolt-elements-textPrimary">Managed agents (one per model tier)</div>
        <div className="text-xs text-bolt-elements-textTertiary break-words">{detail}</div>
        {lines.map((line) => (
          <div key={line} className="text-xs text-bolt-elements-textSecondary break-words">
            {line}
          </div>
        ))}
      </div>
      <button
        className="text-xs px-2 py-1 rounded bg-bolt-elements-background-depth-3 text-bolt-elements-textSecondary disabled:opacity-50 shrink-0"
        disabled={busy || !state || !state.configured}
        onClick={() => void provision()}
      >
        {busy ? 'Provisioning…' : 'Provision managed agents'}
      </button>
    </div>
  );
}
