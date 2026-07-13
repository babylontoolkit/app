/**
 * The vague-prompt offer (SPEC §4.4a Path C).
 *
 * This appears for exactly one kind of prompt: one that names no genre, no mechanic and no subject
 * ("I want to make a game", "help"). It is the ONLY automatic route to the wizard in the product — and
 * even here the wizard is OFFERED, not forced, because "explicit user input > inference > guidance"
 * still holds when the input is thin. Both buttons lead somewhere; neither is a dead end.
 */
import { classNames } from '~/utils/classNames';

interface VaguePromptOfferProps {
  onChoose: (choice: 'tour' | 'blank') => void;
  onTour: () => void;
}

export function VaguePromptOffer({ onChoose, onTour }: VaguePromptOfferProps) {
  return (
    <div
      className={classNames(
        'flex flex-col sm:flex-row sm:items-center gap-3 justify-between',
        'p-4 rounded-lg border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2',
      )}
    >
      <p className="text-sm text-bolt-elements-textPrimary">
        Happy to help — what kind of game? Want a guided setup, or just start from a blank scene?
      </p>

      <div className="flex gap-2 shrink-0">
        <button
          type="button"
          onClick={() => {
            onChoose('tour');
            onTour();
          }}
          className={classNames(
            'px-3 py-1.5 rounded-lg text-sm font-medium transition-theme',
            'bg-bolt-elements-button-primary-background text-bolt-elements-button-primary-text',
            'hover:bg-bolt-elements-button-primary-backgroundHover',
          )}
        >
          Guided setup
        </button>
        <button
          type="button"
          onClick={() => onChoose('blank')}
          className={classNames(
            'px-3 py-1.5 rounded-lg text-sm transition-theme',
            'border border-bolt-elements-borderColor text-bolt-elements-textSecondary',
            'hover:text-bolt-elements-textPrimary hover:bg-bolt-elements-background-depth-3',
          )}
        >
          Blank scene
        </button>
      </div>
    </div>
  );
}
