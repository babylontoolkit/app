/**
 * Managed agent provisioning (`_specs/managed-agents-engine_plan.md` T3, T12) — one row under Agent
 * repository, beside Synchronize. Synchronize builds the prompt version AND provisions the managed agent
 * from it (T12); this button is the manual / retry path. Re-pressing with nothing changed is a no-op on
 * the server (hash-skipped), so the button is safe to press.
 */
import { useEffect, useState } from 'react';
import { toast } from 'react-toastify';

interface ManagedAgentState {
  configured: boolean;
  engine?: string;
  message?: string;
  key?: string;
  current?: boolean;
  agent?: {
    agentId: string;
    agentVersion: number;
    referenceSha: string;
    referenceFiles: number;
    skills: string[];
    provisionedAt: string;
  } | null;
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
      };

      if (r.status === 503) {
        toast.error(`Not configured: ${data.message ?? 'the managed agent engine is not configured.'}`);
        return;
      }

      if (!r.ok || !data.ok) {
        toast.error(data.message ?? 'Provisioning failed.');
        return;
      }

      toast.success(
        data.status === 'unchanged'
          ? `Already current — ${data.agentId} v${data.agentVersion}.`
          : `Managed agent ${data.status} — ${data.agentId} v${data.agentVersion}.`,
      );
      load();
    } finally {
      setBusy(false);
    }
  };

  let detail: string;

  if (!state) {
    detail = 'Loading…';
  } else if (!state.configured) {
    detail = `Not configured: ${state.message ?? ''}`;
  } else if (!state.agent) {
    detail = `Not provisioned (${state.key}) — press Synchronize (it provisions) or Provision managed agent.`;
  } else {
    const a = state.agent;
    detail =
      `${a.agentId} v${a.agentVersion} · ${state.key} · docs ${a.referenceSha.slice(0, 8)} (${a.referenceFiles} files) · ` +
      `${a.skills.length} skill${a.skills.length === 1 ? '' : 's'}` +
      (state.current ? '' : ' · from an earlier prompt version — provision to update') +
      (state.engine === 'managed' ? '' : ' · engine: legacy');
  }

  return (
    <div className="flex items-start gap-3 px-3 py-2 rounded-md border border-bolt-elements-borderColor">
      <div className="flex-1 min-w-0">
        <div className="text-sm text-bolt-elements-textPrimary">Managed agent</div>
        <div className="text-xs text-bolt-elements-textTertiary break-words">{detail}</div>
      </div>
      <button
        className="text-xs px-2 py-1 rounded bg-bolt-elements-background-depth-3 text-bolt-elements-textSecondary disabled:opacity-50 shrink-0"
        disabled={busy || !state || !state.configured}
        onClick={() => void provision()}
      >
        {busy ? 'Provisioning…' : 'Provision managed agent'}
      </button>
    </div>
  );
}
