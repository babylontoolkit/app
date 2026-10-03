/**
 * The EFFORT PILL (`_specs/effort-selector_plan.md` D7) — the always-visible readout of the thinking
 * effort the next turn will ask for, and the trigger for `EffortPanel`.
 *
 * It sits in the composer's right group just before the model pill: both are standing properties of the
 * session rather than actions on this message, and both move the bill.
 *
 * 🔴 FIXED WIDTH (§4.1a — "a right-aligned toolbar must not RESIZE"). The label changes with the level
 * ("High" → "Extra high"), and a pill sized to its text would shift every control to its left on each
 * change. Every label is rendered into the SAME grid cell and only the current one is visible, so the
 * pill is always as wide as the widest label — whatever the font, and whatever level is selected.
 *
 * 🔴 COMPACT once a project is open (measured live 2026-10-02). The chat column is a fixed
 * `--chat-min-width` (533px), so the composer row is 457px wide, and with the context dot in the left
 * group the right group has ~139px: the model pill takes ~99 of it, leaving ≤40px. The labelled pill is
 * 87px and pushed the model pill 35px past the composer's border. So in the open-project row the pill is
 * a level METER — one bar per offered level, filled up to the current one (a miniature of the panel's
 * notches) — 26px wide, fixed (it reserves room for every level), with the level named in its tooltip
 * and accessible name. The landing composer has the room and keeps the labelled pill.
 */
import { useStore } from '@nanostores/react';
import { classNames } from '~/utils/classNames';
import { USER_EFFORT_LEVELS } from '~/lib/modules/llm/capabilities';
import { EFFORT_LABELS, baseEffortStore, effortPanelOpen, offeredEffortLevelsStore } from '~/lib/stores/effort';
import { EFFORT_PILL_ATTR } from './EffortPanel';

/**
 * The pill's class string — `IconButton`'s base look (a plain `<button>` here because `IconButton` does
 * not forward ARIA or data attributes) with the model pill's compact `px-1`. Exported so a spec can pin
 * that it does not depend on the selected level.
 */
export const EFFORT_PILL_CLASS =
  'flex items-center gap-1 rounded-md px-1 py-1 transition-all bg-transparent text-bolt-elements-item-contentDefault hover:text-bolt-elements-item-contentActive hover:bg-bolt-elements-item-backgroundActive focus:outline-none';

/** Bar heights (px) for the compact meter, lowest level first. */
const METER_HEIGHTS = [5, 8, 11, 14];

interface EffortPillProps {
  /** The open-project composer row has no room for a label — render the level meter instead. */
  compact?: boolean;
}

export function EffortPill({ compact = false }: EffortPillProps) {
  const effort = useStore(baseEffortStore);
  const offered = useStore(offeredEffortLevelsStore);
  const open = useStore(effortPanelOpen);
  const label = EFFORT_LABELS[effort];
  const currentIndex = offered.indexOf(effort);

  return (
    <button
      type="button"
      title={`Thinking effort: ${label}. Click to change.`}
      aria-label={`Thinking effort: ${label}`}
      aria-haspopup="dialog"
      aria-expanded={open}
      className={classNames(EFFORT_PILL_CLASS, {
        '!bg-bolt-elements-item-backgroundAccent !text-bolt-elements-item-contentAccent': open,
      })}
      onClick={() => effortPanelOpen.set(!effortPanelOpen.get())}
      {...{ [EFFORT_PILL_ATTR]: '' }}
    >
      {/*
       * Compact: fixed at four bars' width whatever is offered, so a deploy switching Max on or off never
       * resizes the row either; the bars present are centred in it.
       */}
      {compact ? (
        <span
          aria-hidden="true"
          data-testid="effort-pill-meter"
          className="flex items-end justify-center gap-[2px] w-[18px] h-[16px]"
        >
          {offered.map((level, index) => (
            <span
              key={level}
              data-filled={index <= currentIndex}
              className={classNames(
                'block w-[3px] rounded-[1px]',
                index <= currentIndex ? 'bg-bolt-elements-item-contentAccent' : 'bg-bolt-elements-borderColor',
              )}
              style={{ height: METER_HEIGHTS[index] ?? METER_HEIGHTS[METER_HEIGHTS.length - 1] }}
            />
          ))}
        </span>
      ) : (
        <>
          <div className="i-ph:gauge text-lg" />
          <span className="grid text-xs whitespace-nowrap" data-testid="effort-pill-label">
            {USER_EFFORT_LEVELS.map((level) => (
              <span
                key={level}
                aria-hidden={level !== effort}
                className={classNames('[grid-area:1/1] text-left', level === effort ? 'visible' : 'invisible')}
              >
                {EFFORT_LABELS[level]}
              </span>
            ))}
          </span>
        </>
      )}
    </button>
  );
}
