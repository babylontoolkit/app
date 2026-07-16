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
import { memo, useEffect, useRef, useState } from 'react';
import { classNames } from '~/utils/classNames';

/** Px from the bottom still counted as "at the bottom" — covers sub-pixel rounding and momentum. */
const STICK_THRESHOLD_PX = 24;

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

  const scrollRef = useRef<HTMLDivElement>(null);

  /*
   * Follow the thinking as it streams — but ONLY while the user is already at the bottom.
   *
   * A think runs 157 seconds on a real creation and this box is 16rem tall, so without this every new
   * sentence lands below the fold and the user has to hand-scroll to watch the thing we deliberately
   * pay to show them. The `stuck` flag is the whole design: the instant they scroll UP (to re-read a
   * decision the model just made) we stop yanking them back down. An auto-scroll that cannot be
   * escaped is worse than none — it makes the panel unreadable rather than merely static.
   */
  const [stuck, setStuck] = useState(true);

  useEffect(() => {
    const el = scrollRef.current;

    if (!el || !expanded || !stuck) {
      return;
    }

    el.scrollTop = el.scrollHeight;
  }, [reasoning, expanded, stuck]);

  const onScroll = () => {
    const el = scrollRef.current;

    if (!el) {
      return;
    }

    setStuck(el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_THRESHOLD_PX);
  };

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
        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="px-3 pb-3 pt-1 text-sm text-bolt-elements-textSecondary whitespace-pre-wrap border-t border-bolt-elements-borderColor max-h-64 overflow-y-auto"
        >
          {reasoning}
        </div>
      )}
    </div>
  );
});
