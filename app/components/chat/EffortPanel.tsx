/**
 * The effort picker (SPEC §4.2.9; `_specs/effort-selector_plan.md` D7) — a notched slider over the levels
 * this deploy offers (Medium · High · Extra high, plus Max when `ENABLE_MAX_EFFORT` is on; never Low).
 *
 * Opened by the composer's `EffortPill`, by `/effort`, or by the effort row in the `/context` report. The
 * current value is always on screen in the pill, so the panel's job is the CHOICE and its consequence:
 * the selected level's description (honest about credits — thinking bills as output) and, on the managed
 * engine, that a change starts a fresh agent session on the next message (a session's effort is fixed
 * for its life, so the engine moves the chat to a new one — D3).
 *
 * Selecting a notch applies immediately and leaves the panel open (it is a slider: arrow keys walk the
 * notches, and the description follows). Escape, the close button, or a click outside closes it.
 */
import { useEffect, useRef } from 'react';
import { useStore } from '@nanostores/react';
import { IconButton } from '~/components/ui/IconButton';
import { NotchedSlider } from '~/components/ui/NotchedSlider';
import {
  EFFORT_DESCRIPTIONS,
  EFFORT_LABELS,
  baseEffortStore,
  effortPanelOpen,
  offeredEffortLevelsStore,
  setBaseEffort,
} from '~/lib/stores/effort';
import { sessionStore } from '~/lib/stores/session';

/** Marks the pill, so a click on it is not also an "outside click" that closes the panel it is toggling. */
export const EFFORT_PILL_ATTR = 'data-effort-pill';

export function EffortPanel() {
  const current = useStore(baseEffortStore);
  const offered = useStore(offeredEffortLevelsStore);
  const open = useStore(effortPanelOpen);
  const session = useStore(sessionStore);
  const panelRef = useRef<HTMLDivElement>(null);

  /*
   * Escape and outside clicks close it. Bound while open only, so they never compete with anything else.
   * A pointerdown on the pill is excluded: the pill's own click toggles the panel, and closing here first
   * would make that click re-open it.
   */
  useEffect(() => {
    if (!open) {
      return undefined;
    }

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        effortPanelOpen.set(false);
      }
    };

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Element | null;

      if (!target || panelRef.current?.contains(target) || target.closest?.(`[${EFFORT_PILL_ATTR}]`)) {
        return;
      }

      effortPanelOpen.set(false);
    };

    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onPointerDown);

    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open]);

  /*
   * 🔴 THE ANCHOR IS ALWAYS RENDERED; only the POPUP is conditional (§4.1a — "a right-aligned toolbar must
   * not RESIZE"). Returning `null` when closed removed a flex child, so opening the picker inserted one
   * `gap-1` and shifted every control beside it by exactly 4px — measured live in Chrome. Holding the
   * space from first paint costs nothing (the anchor is zero-width) and makes both states identical.
   */
  return (
    <div className="relative">
      {open && (
        <div
          ref={panelRef}
          role="dialog"
          aria-label="Thinking effort"
          className="absolute bottom-full right-0 mb-2 w-80 z-50 rounded-lg border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 shadow-lg p-4 text-sm text-bolt-elements-textPrimary"
        >
          <div className="flex items-center justify-between mb-3">
            <span className="font-medium">Thinking effort</span>
            <IconButton title="Close" className="transition-all" onClick={() => effortPanelOpen.set(false)}>
              <div className="i-ph:x text-base" />
            </IconButton>
          </div>
          <NotchedSlider
            ariaLabel="Thinking effort"
            options={offered.map((level) => ({ value: level, label: EFFORT_LABELS[level] }))}
            selected={current}
            onSelect={setBaseEffort}
            className="px-1"
          />
          <p className="mt-3 text-xs leading-snug text-bolt-elements-textPrimary" data-testid="effort-description">
            <span className="font-medium">{EFFORT_LABELS[current]}.</span> {EFFORT_DESCRIPTIONS[current]}
          </p>
          {session.agentEngine === 'managed' && (
            <div className="mt-3 pt-2 border-t border-bolt-elements-borderColor text-[11px] leading-snug text-bolt-elements-textSecondary">
              Changing effort starts a fresh agent session on your next message (your project and chat stay).
            </div>
          )}
        </div>
      )}
    </div>
  );
}
