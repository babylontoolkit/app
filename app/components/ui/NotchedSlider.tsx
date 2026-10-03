/**
 * A notched slider: N discrete stops on a track, a label under each, one selected.
 *
 * Built for the effort control (`_specs/effort-selector_plan.md` D7) as a NEW component rather than a
 * generalisation of `Slider.tsx`: that one is a 3-option segmented pill whose framer-motion
 * `layoutId="pill-tab"` is shared by every instance and is used by the workbench header — widening it
 * would change a control nobody asked to change.
 *
 * Semantics are a radio group (WAI-ARIA radio pattern): `role="radiogroup"` with one `role="radio"` per
 * notch, `aria-checked` on the selected one, roving `tabIndex` (only the selected notch is a tab stop),
 * and the arrow keys / Home / End move the selection and focus with it.
 */
import { useRef, type KeyboardEvent } from 'react';
import { classNames } from '~/utils/classNames';

export interface NotchedSliderOption<T extends string> {
  value: T;
  label: string;
}

interface NotchedSliderProps<T extends string> {
  options: readonly NotchedSliderOption<T>[];
  selected: T;
  onSelect: (value: T) => void;

  /** The group's accessible name, e.g. "Thinking effort". */
  ariaLabel: string;
  className?: string;
}

export function NotchedSlider<T extends string>({
  options,
  selected,
  onSelect,
  ariaLabel,
  className,
}: NotchedSliderProps<T>) {
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const count = options.length;
  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.value === selected),
  );

  const moveTo = (index: number) => {
    const next = Math.min(count - 1, Math.max(0, index));
    onSelect(options[next].value);
    buttons.current[next]?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowUp':
        event.preventDefault();
        moveTo(selectedIndex + 1);
        break;
      case 'ArrowLeft':
      case 'ArrowDown':
        event.preventDefault();
        moveTo(selectedIndex - 1);
        break;
      case 'Home':
        event.preventDefault();
        moveTo(0);
        break;
      case 'End':
        event.preventDefault();
        moveTo(count - 1);
        break;
      default:
        break;
    }
  };

  /*
   * The track runs from the centre of the first notch to the centre of the last; each notch sits in an
   * equal column, so a column's centre is at (i + 0.5) / N of the width.
   */
  const inset = `${50 / count}%`;
  const span = 100 - 100 / count;
  const fill = count > 1 ? (selectedIndex / (count - 1)) * span : 0;

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={classNames('relative select-none', className)}
      onKeyDown={onKeyDown}
    >
      <div
        aria-hidden="true"
        className="absolute top-[9px] h-0.5 rounded-full bg-bolt-elements-borderColor"
        style={{ left: inset, right: inset }}
      />
      <div
        aria-hidden="true"
        className="absolute top-[9px] h-0.5 rounded-full bg-bolt-elements-item-contentAccent transition-all"
        style={{ left: inset, width: `${fill}%` }}
      />
      <div className="relative grid" style={{ gridTemplateColumns: `repeat(${count}, minmax(0, 1fr))` }}>
        {options.map((option, index) => {
          const active = index === selectedIndex;
          const passed = index <= selectedIndex;

          return (
            <button
              key={option.value}
              ref={(element) => {
                buttons.current[index] = element;
              }}
              type="button"
              role="radio"
              aria-checked={active}
              tabIndex={active ? 0 : -1}
              className="group flex flex-col items-center gap-1.5 bg-transparent outline-none"
              onClick={() => moveTo(index)}
            >
              <span
                aria-hidden="true"
                className={classNames(
                  'block rounded-full border-2 transition-all',
                  'group-focus-visible:ring-2 group-focus-visible:ring-bolt-elements-item-contentAccent',
                  active ? 'w-3.5 h-3.5 mt-[3px]' : 'w-2.5 h-2.5 mt-[5px] mb-[2px]',
                  passed
                    ? 'border-bolt-elements-item-contentAccent bg-bolt-elements-item-contentAccent'
                    : 'border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 group-hover:border-bolt-elements-textSecondary',
                )}
              />
              <span
                className={classNames(
                  'text-[11px] leading-tight whitespace-nowrap',
                  active
                    ? 'text-bolt-elements-item-contentAccent font-medium'
                    : 'text-bolt-elements-textSecondary group-hover:text-bolt-elements-textPrimary',
                )}
              >
                {option.label}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
