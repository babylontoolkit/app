/**
 * What renders while `useChatHistory` is not `ready` — the window that used to be a blank page.
 *
 * Opening a project serializes behind real work (waking the sandbox VM, re-scanning the project,
 * dependency checks), which on a server provider is tens of seconds after a hibernation. During all
 * of it `Chat.client.tsx` rendered nothing, so the user saw the header over an empty page with no
 * signal that anything was happening. This surface narrates the wait from `bootProgress`, the store
 * the mount path phases into.
 *
 * `CreationSplash` is the same story one page earlier: NEW PROJECT creation does comparable work
 * (starter download, sandbox boot/fork, template mount, visibility wait) while the chat is already
 * rendered, so it overlays rather than replaces. One store, one copy table, one status panel — a
 * second renderer with its own strings is exactly the two-writers drift this repo keeps refinding.
 *
 * The 250ms reveal delay is deliberate: `ready` starts false for ONE React commit even on the plain
 * landing page (the effect that sets it runs after first paint), and a boot screen that flashes on
 * every visit to `/` reads as jank. Anything shorter than the delay stays a blank frame, exactly as
 * before. (CSS keyframe utilities are not an option here — the repo's animate-* classes are inert,
 * see `toolbar-button.spec.ts` INERT_BY_DESIGN.)
 */
import { useStore } from '@nanostores/react';
import { useEffect, useState } from 'react';
import { bootProgress, bootPhaseCopy, bootRetry, isCreationPhase } from '~/lib/stores/boot-progress';

/**
 * The terminal state: no spinner, the server's own sentence, and a way forward.
 *
 * A failed open used to render as the boot screen disappearing over an empty workbench — the failure
 * mode this repo keeps rediscovering, where the honest answer ("this did not work, here is why")
 * loses to a surface that simply stops. The retry is offered only when the failure is retryable,
 * because a button that cannot help is worse than none: it teaches the user that pressing it does
 * nothing.
 */
function BootFailurePanel({ message, retryable }: { message: string; retryable: boolean }) {
  const retry = useStore(bootRetry);

  return (
    <div className="flex max-w-md flex-col items-center gap-4 text-center" role="alert">
      <div className="i-ph:warning-circle text-4xl text-bolt-elements-icon-error" aria-hidden="true" />
      <div>
        <div className="text-lg font-medium text-bolt-elements-textPrimary">Your workspace could not be opened</div>
        <div className="mt-1 text-sm text-bolt-elements-textSecondary">{message}</div>
      </div>
      {retryable && retry && (
        <button
          type="button"
          onClick={retry}
          className="rounded-md bg-bolt-elements-button-primary-background px-4 py-2 text-sm text-bolt-elements-button-primary-text hover:bg-bolt-elements-button-primary-backgroundHover"
        >
          Try again
        </button>
      )}
    </div>
  );
}

/** Spinner + phase copy + progress + elapsed — the shared body of both boot surfaces. */
function BootStatusPanel() {
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

  /*
   * After the hooks, never before: the panel must keep its reveal timer and elapsed clock mounted
   * across the transition into a failure, or the whole surface unmounts and remounts mid-open.
   */
  if (phase.step === 'failed') {
    return <BootFailurePanel message={phase.message} retryable={phase.retryable} />;
  }

  const copy = bootPhaseCopy(phase);
  const fraction =
    phase.step === 'files' && phase.done !== undefined && phase.total ? Math.min(1, phase.done / phase.total) : null;

  return (
    <div
      className="flex flex-col items-center gap-4"
      style={{ opacity: visible ? 1 : 0, transition: 'opacity 300ms ease' }}
      role="status"
      aria-live="polite"
    >
      <div className="i-svg-spinners:90-ring-with-bg text-bolt-elements-loader-progress text-4xl" aria-hidden="true" />
      <div className="text-center">
        <div className="text-lg font-medium text-bolt-elements-textPrimary">{copy.title}</div>
        {/*
         * The elapsed clock rides at the END of the detail line, not on a line of its own.
         *
         * It is a footnote to "what is happening", so a bare `12s` centred under the panel read as a
         * fourth, unexplained element — and on the phases with no progress bar it was the only thing
         * moving, which drew the eye to the least important number on screen. Tabular figures so the
         * text does not jitter as the digits change, and it still only appears after 5s: a wait that
         * ends quickly should never have been counted out loud.
         */}
        <div className="mt-1 text-sm text-bolt-elements-textSecondary">
          {copy.detail}
          {elapsedSeconds >= 5 && (
            <span className="ml-1.5 text-bolt-elements-textTertiary tabular-nums">· {elapsedSeconds}s</span>
          )}
        </div>
      </div>
      {fraction !== null && (
        <div className="h-1 w-64 overflow-hidden rounded-full bg-bolt-elements-background-depth-3">
          <div
            className="h-full rounded-full bg-bolt-elements-loader-progress"
            style={{ width: `${Math.round(fraction * 100)}%`, transition: 'width 200ms ease' }}
          />
        </div>
      )}
    </div>
  );
}

/** Full-page boot narration for the resume/open path, where nothing else has rendered yet. */
export function BootScreen() {
  return (
    <div className="flex w-full flex-1 items-center justify-center px-6">
      <BootStatusPanel />
    </div>
  );
}

/**
 * The NEW PROJECT splash — an overlay over the (already rendered) landing/chat while `startProject`
 * runs. Renders nothing outside the `creating-*` phases, so the resume path (which shows the
 * full-page `BootScreen` instead) can never double-render it. Mount-gated on the phase so the
 * panel's reveal delay and elapsed clock start when creation starts, not when the page did.
 *
 * 🔴 **IT MUST LOOK LIKE `BootScreen`, because it IS the same moment.** Creating and resuming are one
 * experience to a user — "my project is coming up" — and they were drawn as two different things: the
 * resume path a calm full-page surface, the creation path a small card floating on a dimmed, blurred
 * backdrop. Same store, same copy table, same panel, two visual languages, and the modal one read as
 * the cheaper of the two.
 *
 * 🔴 **"The same" means the same AMOUNT OF SCREEN — the CONTENT WINDOW, never the whole page (owner
 * decision 2026-07-27).** Both surfaces leave the sidebar and header reachable, and the reason is not
 * aesthetic: a progress surface that covers everything is a TRAP. Creation and boot both wait on work
 * that can stall (a cold VM, a slow starter fetch, a provider having a bad minute), and when it does the
 * user must still be able to reach the dashboard, another project, or settings. So this stays at `z-50`
 * — under `.z-sidebar` (997) and the header — and the resume path renders the sidebar alongside
 * `BootScreen` rather than replacing the page with it. It briefly went full-page (`.z-max`) to match
 * resume; that made the two consistent by making BOTH a trap, which is the wrong direction.
 */
export function CreationSplash() {
  const phase = useStore(bootProgress);

  if (!isCreationPhase(phase)) {
    return null;
  }

  return (
    <div className="creation-splash fixed inset-0 z-50 flex items-center justify-center px-6 bg-bolt-elements-background-depth-1">
      <BootStatusPanel />
    </div>
  );
}
