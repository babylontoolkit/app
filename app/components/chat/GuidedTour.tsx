/**
 * The Guided Tour wizard (SPEC §4.7) — the non-developer front door.
 *
 * Four steps: game type → vibe → mechanics → your twist. It compiles to a first message and drops the
 * user into the builder with generation already streaming (target: first playable change in under 90
 * seconds).
 *
 * It is reached ONLY by explicit request, or when a prompt is too vacuous to act on — and even then
 * it is offered, never forced (§4.4a Path C). Content is data (`app/config/wizard.json`), so genres,
 * vibes and mechanics change without a deploy.
 */
import { useMemo, useState } from 'react';
import { Dialog, DialogRoot } from '~/components/ui/Dialog';
import { classNames } from '~/utils/classNames';
import type { GameRegistryEntry } from '~/types/game-registry';
import { WIZARD_CONFIG, type WizardSelection, mechanicsFor, summarizeSelection } from '~/lib/registry/wizard';

interface GuidedTourProps {
  open: boolean;
  entries: GameRegistryEntry[];
  onClose: () => void;
  onComplete: (selection: WizardSelection) => void;
}

const STEPS = ['Game type', 'Vibe', 'Features', 'Your twist'] as const;

export function GuidedTour({ open, entries, onClose, onComplete }: GuidedTourProps) {
  const [step, setStep] = useState(0);
  const [entry, setEntry] = useState<GameRegistryEntry | null>(null);
  const [vibeId, setVibeId] = useState<string | undefined>();
  const [mechanicIds, setMechanicIds] = useState<string[]>([]);
  const [twist, setTwist] = useState('');

  const mechanics = useMemo(
    () =>
      entry
        ? // A gated mechanic (e.g. an online leaderboard) stays hidden until its requirement is met.
          mechanicsFor(entry.id).filter((mechanic) => !mechanic.requires)
        : [],
    [entry],
  );

  const selection: WizardSelection | null = entry ? { entry, vibeId, mechanicIds, twist } : null;
  const canAdvance = step === 0 ? Boolean(entry) : true;

  const reset = () => {
    setStep(0);
    setEntry(null);
    setVibeId(undefined);
    setMechanicIds([]);
    setTwist('');
  };

  const close = () => {
    reset();
    onClose();
  };

  const toggleMechanic = (id: string) => {
    setMechanicIds((current) =>
      current.includes(id) ? current.filter((existing) => existing !== id) : [...current, id],
    );
  };

  const optionClass = (selected: boolean) =>
    classNames(
      'w-full text-left p-3 rounded-lg border transition-theme',
      selected
        ? 'border-bolt-elements-focus bg-bolt-elements-item-backgroundAccent text-bolt-elements-item-contentAccent'
        : 'border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 hover:bg-bolt-elements-background-depth-3 text-bolt-elements-textPrimary',
    );

  return (
    <DialogRoot open={open} onOpenChange={(next) => !next && close()}>
      <Dialog onClose={close} className="max-w-2xl">
        <div className="p-6 flex flex-col gap-5">
          <div>
            <h2 className="text-lg font-medium text-bolt-elements-textPrimary">Let&apos;s build your game</h2>
            <p className="text-sm text-bolt-elements-textSecondary mt-1">
              Step {step + 1} of {STEPS.length} — {STEPS[step]}
            </p>
          </div>

          <div className="flex gap-1">
            {STEPS.map((label, index) => (
              <div
                key={label}
                className={classNames(
                  'h-1 flex-1 rounded-full transition-theme',
                  index <= step ? 'bg-bolt-elements-focus' : 'bg-bolt-elements-borderColor',
                )}
              />
            ))}
          </div>

          <div className="min-h-64 max-h-96 overflow-y-auto flex flex-col gap-2">
            {step === 0 &&
              entries.map((candidate) => (
                <button
                  key={candidate.id}
                  type="button"
                  onClick={() => setEntry(candidate)}
                  className={optionClass(entry?.id === candidate.id)}
                >
                  <div className="text-sm font-medium">{candidate.title}</div>
                  <div className="text-xs opacity-80 mt-0.5">{candidate.description}</div>
                </button>
              ))}

            {step === 1 &&
              WIZARD_CONFIG.vibes.map((vibe) => (
                <button
                  key={vibe.id}
                  type="button"
                  onClick={() => setVibeId(vibeId === vibe.id ? undefined : vibe.id)}
                  className={optionClass(vibeId === vibe.id)}
                >
                  <div className="text-sm font-medium">{vibe.label}</div>
                  <div className="text-xs opacity-80 mt-0.5">{vibe.description}</div>
                </button>
              ))}

            {step === 2 &&
              (mechanics.length === 0 ? (
                <p className="text-sm text-bolt-elements-textSecondary">
                  A blank canvas has no presets — tell us what you want in the next step.
                </p>
              ) : (
                mechanics.map((mechanic) => (
                  <button
                    key={mechanic.id}
                    type="button"
                    onClick={() => toggleMechanic(mechanic.id)}
                    className={optionClass(mechanicIds.includes(mechanic.id))}
                  >
                    <div className="text-sm font-medium">{mechanic.label}</div>
                  </button>
                ))
              ))}

            {step === 3 && (
              <div className="flex flex-col gap-3">
                <textarea
                  value={twist}
                  onChange={(event) => setTwist(event.target.value)}
                  rows={3}
                  placeholder="the cars are shopping carts"
                  className={classNames(
                    'w-full p-3 rounded-lg resize-none outline-none',
                    'border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2',
                    'text-bolt-elements-textPrimary placeholder:text-bolt-elements-textTertiary',
                    'focus:border-bolt-elements-focus',
                  )}
                />
                {selection && (
                  <div className="p-3 rounded-lg bg-bolt-elements-background-depth-2 border border-bolt-elements-borderColor">
                    <div className="text-xs text-bolt-elements-textTertiary mb-1">We&apos;ll build</div>
                    <div className="text-sm text-bolt-elements-textPrimary">{summarizeSelection(selection)}</div>
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="flex justify-between items-center">
            <button
              type="button"
              onClick={step === 0 ? close : () => setStep(step - 1)}
              className="text-sm text-bolt-elements-textSecondary hover:text-bolt-elements-textPrimary"
            >
              {step === 0 ? 'Cancel' : 'Back'}
            </button>

            <button
              type="button"
              disabled={!canAdvance}
              onClick={() => {
                if (step < STEPS.length - 1) {
                  setStep(step + 1);
                  return;
                }

                if (selection) {
                  const completed = selection;
                  reset();
                  onComplete(completed);
                }
              }}
              className={classNames(
                'px-4 py-2 rounded-lg text-sm font-medium transition-theme',
                canAdvance
                  ? 'bg-bolt-elements-button-primary-background text-bolt-elements-button-primary-text hover:bg-bolt-elements-button-primary-backgroundHover'
                  : 'bg-bolt-elements-background-depth-3 text-bolt-elements-textTertiary cursor-not-allowed',
              )}
            >
              {step === STEPS.length - 1 ? 'Build my game' : 'Next'}
            </button>
          </div>
        </div>
      </Dialog>
    </DialogRoot>
  );
}
