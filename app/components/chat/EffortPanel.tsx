/**
 * The `/effort` picker (SPEC §4.2.9) — choose this session's base thinking effort.
 *
 * Rendered in the chat toolbar row but INVISIBLE until opened, deliberately: the row is already crowded
 * (§4.1a's lesson one level down), and effort is a rarely-changed session setting, not a per-turn toggle
 * like Plan/Build. It is reached by `/effort` or by clicking the effort row in the `/context` report; the
 * value it holds is always visible in the model pill's tooltip and in that report, so a raised floor is
 * never invisible even though its control is.
 *
 * The panel states the credit consequence on the expensive option rather than only naming it. `high` is
 * more thinking tokens on every turn, billed at the full output rate — the user should be choosing that
 * knowingly.
 */
import { useEffect } from 'react';
import { useStore } from '@nanostores/react';
import { classNames } from '~/utils/classNames';
import { IconButton } from '~/components/ui/IconButton';
import {
  EFFORT_DESCRIPTIONS,
  EFFORT_LABELS,
  baseEffortStore,
  effortPanelOpen,
  setBaseEffort,
  type UserEffortLevel,
} from '~/lib/stores/effort';
import { USER_EFFORT_LEVELS } from '~/lib/modules/llm/capabilities';

export function EffortPanel() {
  const current = useStore(baseEffortStore);
  const open = useStore(effortPanelOpen);

  /*
   * Escape closes it. The panel is opened by a TYPED COMMAND, so a user who opens it by reflex and does not
   * want it has no muscle-memory affordance to reach for other than this — and an overlay sitting on the
   * hero with only an X to dismiss reads as stuck. Bound while open only, so it never competes with anything
   * else for the key.
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

    window.addEventListener('keydown', onKey);

    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  /*
   * 🔴 THE ANCHOR IS ALWAYS RENDERED; only the POPUP is conditional (§4.1a — "a right-aligned toolbar must
   * not RESIZE"). Returning `null` when closed removed a flex child, so opening the picker inserted one
   * `gap-1` and shifted every control to its right by exactly 4px — measured live in Chrome, and the same
   * defect class as the preview-gated buttons that render disabled rather than absent. Holding the space
   * from first paint costs nothing (the anchor is zero-width) and makes the two states geometrically
   * identical.
   */
  return (
    <div className="relative">
      {open && (
        <div className="absolute bottom-full right-0 mb-2 w-80 z-50 rounded-lg border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 shadow-lg p-4 text-sm text-bolt-elements-textPrimary">
          <div className="flex items-center justify-between mb-3">
            <span className="font-medium">Thinking effort</span>
            <IconButton title="Close" className="transition-all" onClick={() => effortPanelOpen.set(false)}>
              <div className="i-ph:x text-base" />
            </IconButton>
          </div>
          <div className="space-y-2">
            {USER_EFFORT_LEVELS.map((level: UserEffortLevel) => {
              const active = level === current;

              return (
                <button
                  key={level}
                  type="button"
                  className={classNames(
                    'w-full text-left rounded-md border px-3 py-2 transition-all',
                    active
                      ? 'border-bolt-elements-item-contentAccent bg-bolt-elements-item-backgroundAccent text-bolt-elements-item-contentAccent'
                      : 'border-bolt-elements-borderColor hover:bg-bolt-elements-background-depth-3',
                  )}
                  onClick={() => {
                    setBaseEffort(level);
                    effortPanelOpen.set(false);
                  }}
                >
                  <div className="flex items-center gap-2">
                    <div className={active ? 'i-ph:check-circle-fill text-base' : 'i-ph:circle text-base opacity-50'} />
                    <span className="text-xs font-medium">
                      {EFFORT_LABELS[level]}
                      {level === 'medium' ? ' — default' : ''}
                    </span>
                  </div>
                  <div className="mt-1 text-[11px] leading-snug text-bolt-elements-textSecondary">
                    {EFFORT_DESCRIPTIONS[level]}
                  </div>
                </button>
              );
            })}
          </div>
          <div className="mt-3 pt-2 border-t border-bolt-elements-borderColor text-[11px] leading-snug text-bolt-elements-textSecondary">
            Resets to Medium each session. Repairs and <span className="font-mono">/skill</span> turns still think
            harder on their own — this is the floor, not a cap.
          </div>
        </div>
      )}
    </div>
  );
}
