/**
 * "Started from: Racing — change" (SPEC §4.4a step 3).
 *
 * Seeding infers something on the user's behalf, so it is shown, attributed (hover to see which words
 * fired), and reversible. Inference the user cannot see or undo is how a builder ends up feeling like
 * it is arguing with you.
 *
 * "Change" is offered only until the first generation lands — after that the project has been built
 * on, and re-seeding would throw that away.
 */
import { useStore } from '@nanostores/react';
import { useState } from 'react';
import { classNames } from '~/utils/classNames';
import { projectSeedStore } from '~/lib/stores/project';
import { useGameRegistry } from '~/lib/hooks/useGameRegistry';
import type { GameRegistryEntry } from '~/types/game-registry';

interface StartedFromChipProps {
  /** Re-seed the project from a different entry, re-running the original prompt against it. */
  onReseed?: (entry: GameRegistryEntry) => void;

  canChange?: boolean;
}

export function StartedFromChip({ onReseed, canChange = false }: StartedFromChipProps) {
  const seed = useStore(projectSeedStore);
  const { entries } = useGameRegistry();
  const [open, setOpen] = useState(false);

  if (!seed) {
    return null;
  }

  const alternatives = entries.filter((entry) => entry.id !== seed.entry.id);

  return (
    <div className="relative inline-flex items-center gap-1.5 text-xs">
      <span
        className={classNames(
          'inline-flex items-center gap-1.5 px-2 py-1 rounded-full',
          'bg-bolt-elements-background-depth-2 border border-bolt-elements-borderColor',
          'text-bolt-elements-textSecondary',
        )}
        title={seed.matched?.length ? `Matched: ${seed.matched.join(', ')}` : undefined}
      >
        {seed.entry.icon && <span className={seed.entry.icon} />}
        Started from: <span className="text-bolt-elements-textPrimary">{seed.entry.title}</span>
        {canChange && onReseed && (
          <button
            type="button"
            onClick={() => setOpen(!open)}
            className="ml-1 underline underline-offset-2 hover:text-bolt-elements-textPrimary"
          >
            change
          </button>
        )}
      </span>

      {open && canChange && onReseed && (
        <div
          className={classNames(
            'absolute top-full left-0 mt-1 z-50 w-56 py-1 rounded-lg overflow-hidden',
            'bg-bolt-elements-background-depth-2 border border-bolt-elements-borderColor shadow-lg',
          )}
        >
          {alternatives.map((entry) => (
            <button
              key={entry.id}
              type="button"
              onClick={() => {
                setOpen(false);
                onReseed(entry);
              }}
              className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-bolt-elements-item-backgroundActive text-bolt-elements-textPrimary"
            >
              {entry.icon && <span className={classNames(entry.icon, 'text-bolt-elements-textSecondary')} />}
              {entry.title}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
