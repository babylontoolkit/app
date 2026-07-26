/**
 * The live "what is the model doing right now" indicator (SPEC §4.2a; server: `agent/heartbeat.ts`).
 *
 * Replaces the anonymous dots spinner at the bottom of the message list. A thinking model's stream
 * is legitimately silent for minutes (KIE buffers the whole reasoning window, and currently returns
 * every model's thinking text EMPTY — see `kie-wire.ts`), and dead dots are indistinguishable from
 * a hang while real credits are being spent. While the server's heartbeat parts arrive, this shows
 * an honest, ticking status ("Thinking — 1m 12s"); when they stop — content is flowing, or the
 * heartbeat never started — it falls back to the original dots, so the worst case is exactly the
 * old UI, never less.
 *
 * This panel is NOT a thinking display and never pretends to be: when a provider streams real
 * reasoning text, the ThinkingPanel renders it, the heartbeat goes quiet (real content resets its
 * silence clock server-side), and this collapses back to dots on its own.
 */
import { memo, useEffect, useState } from 'react';
import { useStore } from '@nanostores/react';
import { agentStatusStore, describeAgentStatus, isStatusFresh } from '~/lib/stores/agent-status';
import { activeSkillsStore } from '~/lib/stores/active-skills';
import { SkillBadges } from './SkillBadges';

export const StreamingStatus = memo(() => {
  const status = useStore(agentStatusStore);

  /*
   * The skills this turn is running (§4.11). Independent of the heartbeat: it arrives once, up
   * front, and must stay visible for the WHOLE turn — including the stretches when the heartbeat is
   * quiet because content is flowing. So it renders in both branches below, never only in the panel.
   */
  const active = useStore(activeSkillsStore);
  const skills = active?.skills ?? [];

  /*
   * A 1s tick keeps the elapsed label counting BETWEEN heartbeats (they arrive every ~3s) and lets
   * `isStatusFresh` expire the panel when heartbeats stop without waiting for a store change.
   */
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);

    return () => clearInterval(timer);
  }, []);

  if (!status || !isStatusFresh(status, now)) {
    /*
     * The pre-heartbeat UI. The dots are byte-identical to what this component replaced; the badges
     * sit above them, so "which skill is running" survives the stretches where the heartbeat is
     * silent because real content is streaming.
     */
    return (
      <>
        {skills.length > 0 && (
          <div className="mt-4 flex justify-center">
            <SkillBadges skills={skills} variant="live" />
          </div>
        )}
        <div className="text-center w-full text-bolt-elements-item-contentAccent i-svg-spinners:3-dots-fade text-4xl mt-4"></div>
      </>
    );
  }

  const { label, detail } = describeAgentStatus(status, now);

  return (
    <div className="mt-4 w-full rounded-lg border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 px-3 py-2">
      <div className="flex items-center gap-2 text-sm">
        <div className="text-base i-svg-spinners:90-ring-with-bg text-bolt-elements-item-contentAccent" />
        <span className="font-medium text-bolt-elements-textPrimary">{label}</span>
      </div>
      <div className="mt-1 pl-6 text-xs text-bolt-elements-textSecondary">{detail}</div>
      {skills.length > 0 && (
        <div className="mt-2 pl-6">
          <SkillBadges skills={skills} variant="live" />
        </div>
      )}
    </div>
  );
});
