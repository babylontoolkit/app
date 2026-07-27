/**
 * What renders while `useChatHistory` is not `ready` — the window that used to be a blank page.
 *
 * Opening a project serializes behind real work (waking the sandbox VM, re-scanning the project,
 * dependency checks), which on a server provider is tens of seconds after a hibernation. During all
 * of it `Chat.client.tsx` rendered nothing, so the user saw the header over an empty page with no
 * signal that anything was happening. This surface narrates the wait from `bootProgress`, the store
 * the mount path phases into.
 *
 * The 250ms reveal delay is deliberate: `ready` starts false for ONE React commit even on the plain
 * landing page (the effect that sets it runs after first paint), and a boot screen that flashes on
 * every visit to `/` reads as jank. Anything shorter than the delay stays a blank frame, exactly as
 * before. (CSS keyframe utilities are not an option here — the repo's animate-* classes are inert,
 * see `toolbar-button.spec.ts` INERT_BY_DESIGN.)
 */
import { useStore } from '@nanostores/react';
import { useEffect, useState } from 'react';
import { bootProgress, bootPhaseCopy } from '~/lib/stores/boot-progress';

export function BootScreen() {
  const phase = useStore(bootProgress);
  const [visible, setVisible] = useState(false);
  const [startedAt] = useState(() => Date.now());
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  useEffect(() => {
    const reveal = setTimeout(() => setVisible(true), 250);
    const tick = setInterval(() => setElapsedSeconds(Math.round((Date.now() - startedAt) / 1000)), 1000);

    return () => {
      clearTimeout(reveal);
      clearInterval(tick);
    };
  }, [startedAt]);

  const copy = bootPhaseCopy(phase);
  const fraction =
    phase.step === 'files' && phase.done !== undefined && phase.total ? Math.min(1, phase.done / phase.total) : null;

  return (
    <div
      className="flex w-full flex-1 flex-col items-center justify-center gap-4 px-6"
      style={{ opacity: visible ? 1 : 0, transition: 'opacity 300ms ease' }}
      role="status"
      aria-live="polite"
    >
      <div className="i-svg-spinners:90-ring-with-bg text-bolt-elements-loader-progress text-4xl" aria-hidden="true" />
      <div className="text-center">
        <div className="text-lg font-medium text-bolt-elements-textPrimary">{copy.title}</div>
        <div className="mt-1 text-sm text-bolt-elements-textSecondary">{copy.detail}</div>
      </div>
      {fraction !== null && (
        <div className="h-1 w-64 overflow-hidden rounded-full bg-bolt-elements-background-depth-3">
          <div
            className="h-full rounded-full bg-bolt-elements-loader-progress"
            style={{ width: `${Math.round(fraction * 100)}%`, transition: 'width 200ms ease' }}
          />
        </div>
      )}
      {elapsedSeconds >= 5 && <div className="text-xs text-bolt-elements-textTertiary">{elapsedSeconds}s</div>}
    </div>
  );
}
