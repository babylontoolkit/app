/**
 * The model's reasoning, while it reasons (SPEC §4.2a).
 *
 * ## Why this exists
 *
 * Current Claude models think before they answer, and on a project build that think is long — we
 * measured 90 seconds before the first byte of the artifact. That is not wasted time (it is the model
 * planning the game), but `thinking.display` defaults to `"omitted"`, which means the API bills us for
 * every reasoning token and then sends back a thinking block whose text is EMPTY.
 *
 * So the user sat in front of a spinner for a minute and a half with no idea whether the app was
 * working or hung. It was working. We just had nothing to show, because we were throwing away the one
 * thing that could have shown it.
 *
 * `display: 'summarized'` (see `thinkingFetch`) costs nothing extra — thinking is billed identically
 * under every display setting — and turns those tokens into this panel. The fix for a long think is to
 * SHOW it, not to stop thinking.
 */
import { memo, useState } from 'react';
import { classNames } from '~/utils/classNames';

interface ThinkingPanelProps {
  reasoning: string;

  /** True while this message is still streaming — drives the live "Thinking…" state. */
  streaming: boolean;
}

export const ThinkingPanel = memo(({ reasoning, streaming }: ThinkingPanelProps) => {
  /*
   * Open while it is the only thing happening, collapsed once the artifact starts.
   *
   * Reasoning is context, not the deliverable — leaving it expanded after the build would push the
   * user's actual game off the screen.
   */
  const [expanded, setExpanded] = useState(streaming);

  if (!reasoning.trim()) {
    return null;
  }

  return (
    <div className="mb-3 rounded-lg border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 text-sm text-bolt-elements-textSecondary hover:text-bolt-elements-textPrimary transition-colors"
      >
        <div
          className={classNames('text-base', {
            'i-svg-spinners:90-ring-with-bg text-bolt-elements-item-contentAccent': streaming,
            'i-ph:brain': !streaming,
          })}
        />
        <span className="flex-1 text-left">{streaming ? 'Thinking…' : 'Thought about this'}</span>
        <div className={classNames('text-base transition-transform', expanded ? 'i-ph:caret-up' : 'i-ph:caret-down')} />
      </button>

      {expanded && (
        <div className="px-3 pb-3 pt-1 text-sm text-bolt-elements-textSecondary whitespace-pre-wrap border-t border-bolt-elements-borderColor max-h-64 overflow-y-auto">
          {reasoning}
        </div>
      )}
    </div>
  );
});
