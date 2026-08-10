/**
 * A small "copy this to the clipboard" affordance for a message bubble (owner, 2026-08-09).
 *
 * *"In the chat history text boxes of all my previous prompts… can we add a COPY TEXT feature like a
 * lot of sites have."* The immediate use is re-running a command the agent printed back — the
 * `/bt-execute _specs/<x>_plan.md ALL` in a bubble is a thing you want to send again, and retyping a
 * path by eye is how you end up executing a plan that does not exist.
 *
 * Three details, each of which makes the difference between an affordance and an irritation:
 *
 *   - **Revealed on hover, but never hidden from the keyboard.** `opacity-0 group-hover:opacity-100`
 *     keeps the transcript quiet; `focus-visible:opacity-100` means tabbing to it still shows it, and
 *     it stays in the tab order either way (`opacity`, not `hidden`).
 *   - **It reports what happened.** The icon becomes a check for two seconds — the same feedback the
 *     inherited `CodeBlock` copy button gives, so the two behave alike.
 *   - **A failure is not a silent success.** `navigator.clipboard` is absent outside a secure context
 *     and `writeText` rejects when the permission is denied; either one used to be reported by this
 *     button as a cheerful checkmark and an empty clipboard.
 */
import { useState } from 'react';
import { toast } from 'react-toastify';
import { classNames } from '~/utils/classNames';

interface CopyTextButtonProps {
  /** Exactly the text the user can see. See `user-message-text.ts` for why that is not the raw content. */
  text: string;

  /** Extra positioning classes — the button is otherwise layout-agnostic. */
  className?: string;

  /** Spoken label; the visible tooltip uses the same words. */
  label?: string;
}

export function CopyTextButton({ text, className, label = 'Copy message' }: CopyTextButtonProps) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    if (copied) {
      return;
    }

    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error('The clipboard is not available in this browser context.');
      }

      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /*
       * Loud, because the alternative is a checkmark over an empty clipboard: the user pastes nothing
       * into whatever they were heading for and has no idea which end failed.
       */
      toast.error('Could not copy to the clipboard — your browser blocked it.');
    }
  };

  return (
    <button
      type="button"
      onClick={copy}
      aria-label={copied ? 'Copied' : label}
      title={copied ? 'Copied' : label}
      className={classNames(
        'flex h-6 w-6 items-center justify-center rounded-md',
        'border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2',
        'text-bolt-elements-textTertiary hover:text-bolt-elements-textPrimary',
        'hover:bg-bolt-elements-background-depth-3 transition-all',
        'opacity-0 group-hover:opacity-100 focus-visible:opacity-100',
        className,
      )}
    >
      <div className={copied ? 'i-ph:check text-sm text-green-500' : 'i-ph:copy text-sm'} />
    </button>
  );
}
