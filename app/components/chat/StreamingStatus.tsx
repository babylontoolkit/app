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
import { agentStatusStore, describeAgentStatus, isStatusFresh, type ArtifactProgress } from '~/lib/stores/agent-status';
import { activeSkillsStore } from '~/lib/stores/active-skills';
import { mediaRenderStore } from '~/lib/media/tasks';
import { SkillBadges } from './SkillBadges';

/**
 * "Generating 2 images…" — the render line.
 *
 * Rendered in BOTH branches below, like the skill badges and for the same reason: a render is
 * commissioned in milliseconds and then takes 20–60s at KIE (§4.16), so it routinely outlives both the
 * heartbeat and the whole generation. Showing it only inside the heartbeat panel would hide it during
 * exactly the stretch when it is the only thing still happening — which is the state the user described
 * as the product "spinning for nothing".
 */
function renderLine(images: number, videos: number): string | null {
  if (images === 0 && videos === 0) {
    return null;
  }

  const parts: string[] = [];

  if (images > 0) {
    parts.push(`${images} image${images === 1 ? '' : 's'}`);
  }

  if (videos > 0) {
    parts.push(`${videos} video${videos === 1 ? '' : 's'}`);
  }

  return `Generating ${parts.join(' and ')}…`;
}

/**
 * @param progress How much of the artifact has landed, counted by the CALLER.
 *
 * 🔴 A prop, not a store read, and that is a testability decision with teeth: importing
 * `workbenchStore` here boots a sandbox, an editor store and a watcher as an import side effect, which
 * made this component's own spec unrunnable the moment it was tried. `execution-queue.ts` was extracted
 * for exactly that reason, and the lesson recorded there is that a behaviour no test can reach is how a
 * one-line bug survives. The parent already holds the store; this stays a dumb renderer.
 */
export const StreamingStatus = memo(({ progress: artifact }: { progress?: ArtifactProgress }) => {
  const status = useStore(agentStatusStore);

  /*
   * The skills this turn is running (§4.11). Independent of the heartbeat: it arrives once, up
   * front, and must stay visible for the WHOLE turn — including the stretches when the heartbeat is
   * quiet because content is flowing. So it renders in both branches below, never only in the panel.
   */
  const active = useStore(activeSkillsStore);
  const skills = active?.skills ?? [];

  const renders = useStore(mediaRenderStore);
  const media = renderLine(renders.images, renders.videos);

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
        {media && (
          <div className="mt-4 flex items-center justify-center gap-2 text-xs text-bolt-elements-textSecondary">
            <div className="text-sm i-svg-spinners:90-ring-with-bg text-bolt-elements-item-contentAccent" />
            <span>{media}</span>
          </div>
        )}
        <div className="text-center w-full text-bolt-elements-item-contentAccent i-svg-spinners:3-dots-fade text-4xl mt-4"></div>
      </>
    );
  }

  const { label, detail, progress, fraction, expectation, note } = describeAgentStatus(status, now, artifact);

  return (
    <div className="mt-4 w-full rounded-lg border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 px-3 py-2">
      <div className="flex items-center gap-2 text-sm">
        <div className="text-base i-svg-spinners:90-ring-with-bg text-bolt-elements-item-contentAccent" />
        <span className="font-medium text-bolt-elements-textPrimary">{label}</span>
      </div>
      <div className="mt-1 pl-6 text-xs text-bolt-elements-textSecondary">{detail}</div>
      {/*
       * The expectation bar: how far through a TYPICAL turn of this kind we are.
       *
       * 🔴 It is not a completion bar and must never be mistaken for one — it never fills
       * (`PROGRESS_CAP`), and its caption always names what it is measuring ("usually about 5m").
       * The reason it exists at all is that an elapsed counter rises identically whether the turn is
       * healthy or dead, so watching one is pure anxiety: this is the only element on screen that
       * answers "is this normal?" rather than "how long has it been?".
       *
       * `aria-hidden`, with the same facts already carried as text in the caption beside it — a
       * decorative meter repeated to a screen reader is noise, and the caption is the accessible copy.
       */}
      {fraction !== undefined && (
        <div className="mt-2 pl-6">
          <div className="h-1 w-full overflow-hidden rounded-full bg-bolt-elements-background-depth-3" aria-hidden>
            <div
              className="h-full rounded-full bg-bolt-elements-item-contentAccent transition-[width] duration-1000 ease-linear"
              style={{ width: `${Math.round(fraction * 100)}%` }}
            />
          </div>
          {expectation && (
            <div className="mt-1 text-xs text-bolt-elements-textTertiary tabular-nums">{expectation}</div>
          )}
        </div>
      )}
      {/*
       * The observed facts, on their own line and in tabular figures so the numbers do not shift the
       * text as they tick. Tertiary because it is the most concrete line here and also the one that
       * changes most — keeping it below the explanation keeps the eye on the sentence.
       */}
      {progress && <div className="mt-1 pl-6 text-xs text-bolt-elements-textTertiary tabular-nums">{progress}</div>}
      {/*
       * Why nothing is appearing, on a provider measured to deliver its answer in one batch.
       *
       * Placed LAST of the text lines and styled tertiary on purpose: it is the longest thing in the
       * panel and it is read once, not watched. Above the label it would bury the two lines that
       * change; below them it is there the moment the user starts wondering, which is when they go
       * looking for it.
       */}
      {note && <div className="mt-2 pl-6 text-xs leading-relaxed text-bolt-elements-textTertiary">{note}</div>}
      {media && (
        <div className="mt-1 flex items-center gap-2 pl-6 text-xs text-bolt-elements-textSecondary">
          <div className="text-sm i-svg-spinners:90-ring-with-bg text-bolt-elements-item-contentAccent" />
          <span>{media}</span>
        </div>
      )}
      {skills.length > 0 && (
        <div className="mt-2 pl-6">
          <SkillBadges skills={skills} variant="live" />
        </div>
      )}
    </div>
  );
});
