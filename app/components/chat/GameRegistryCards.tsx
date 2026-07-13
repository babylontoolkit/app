/**
 * New Project entry points B and C (SPEC §4.4a).
 *
 * **Path B** — clicking a card creates the project from that entry and drops the user straight into
 * the builder with an empty chat. No wizard, no interstitial: a picked card is explicit input, and
 * explicit input beats every kind of inference.
 *
 * **Path C** — the guided tour, offered here as a LINK for people who don't know what to type. It is
 * never in anyone's way. The only other route to it is a prompt so vacuous there is nothing to act on
 * (§4.4a) — and even then it is offered, not forced.
 */
import { classNames } from '~/utils/classNames';
import { useGameRegistry } from '~/lib/hooks/useGameRegistry';
import type { GameRegistryEntry } from '~/types/game-registry';
import { GuidedTour } from './GuidedTour';
import type { WizardSelection } from '~/lib/registry/wizard';

interface GameRegistryCardsProps {
  onSelectEntry: (entry: GameRegistryEntry) => void;
  onCompleteTour: (selection: WizardSelection) => void;

  /** Controlled by the parent so the vague-prompt offer can open the same tour. */
  tourOpen: boolean;
  setTourOpen: (open: boolean) => void;
}

export function GameRegistryCards({ onSelectEntry, onCompleteTour, tourOpen, setTourOpen }: GameRegistryCardsProps) {
  const { entries, loading } = useGameRegistry();

  if (loading || entries.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-col items-center gap-4 mt-2">
      <span className="text-sm text-bolt-elements-textTertiary">or start from a game type</span>

      <div className="grid grid-cols-2 md:grid-cols-3 gap-3 w-full max-w-2xl">
        {entries.map((entry) => (
          <button
            key={entry.id}
            type="button"
            onClick={() => onSelectEntry(entry)}
            className={classNames(
              'flex flex-col items-start gap-1 p-3 text-left rounded-lg transition-theme',
              'border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2',
              'hover:border-bolt-elements-focus hover:bg-bolt-elements-background-depth-3',
            )}
          >
            <div className="flex items-center gap-2">
              {entry.icon && <span className={classNames(entry.icon, 'text-lg text-bolt-elements-textSecondary')} />}
              <span className="text-sm font-medium text-bolt-elements-textPrimary">{entry.title}</span>
            </div>
            <span className="text-xs text-bolt-elements-textSecondary line-clamp-2">{entry.description}</span>
          </button>
        ))}
      </div>

      <button
        type="button"
        onClick={() => setTourOpen(true)}
        className="text-sm text-bolt-elements-textSecondary hover:text-bolt-elements-textPrimary underline underline-offset-4"
      >
        Not sure what to build? Take the guided tour
      </button>

      <GuidedTour
        open={tourOpen}
        entries={entries}
        onClose={() => setTourOpen(false)}
        onComplete={(selection) => {
          setTourOpen(false);
          onCompleteTour(selection);
        }}
      />
    </div>
  );
}

export default GameRegistryCards;
