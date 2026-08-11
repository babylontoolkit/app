/**
 * The context health dot + `/context` report panel (SPEC §4.5.6).
 *
 * Reads `contextStatsStore` directly (no prop threading through BaseChat — this is additive-first,
 * upstream files stay untouched). The numbers come from the server's per-generation annotations, so
 * they are the wire truth: the re-sent history POST-compaction and the real billed token counts.
 *
 * Green/amber/red is about the conversation, not the project: the history is the one uncached input
 * that grows forever, and red means the server window is about to start silently dropping the oldest
 * turns — the point where `/clear` costs nothing that was going to be kept anyway.
 */
import { useStore } from '@nanostores/react';
import { classNames } from '~/utils/classNames';
import { contextHealth, contextPanelOpen, contextStatsStore } from '~/lib/stores/context-stats';
import { IconButton } from '~/components/ui/IconButton';
import { EFFORT_LABELS, baseEffortStore, effortPanelOpen } from '~/lib/stores/effort';
import { formatSavings } from '~/lib/billing/ledger-display';

const DOT_COLORS = {
  green: 'bg-green-500',
  amber: 'bg-amber-500',
  red: 'bg-red-500',
} as const;

const HEALTH_ADVICE = {
  green: 'Plenty of room — no need to clear.',
  amber: 'Growing — consider /clear at your next natural break (files are untouched).',
  red: 'Long conversation — oldest turns are being dropped anyway. /clear to start fresh on this same game.',
} as const;

function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export function ContextIndicator() {
  const stats = useStore(contextStatsStore);
  const open = useStore(contextPanelOpen);
  const effort = useStore(baseEffortStore);

  if (!stats) {
    return null;
  }

  const health = contextHealth(stats);
  const historyTokens = Math.round(stats.historyChars / 4);

  return (
    <div className="relative">
      <IconButton
        title={`Context: ${HEALTH_ADVICE[health]} Click for details (/context).`}
        className="transition-all flex items-center gap-1.5 px-1.5"
        onClick={() => contextPanelOpen.set(!open)}
      >
        <span className={classNames('inline-block w-2.5 h-2.5 rounded-full', DOT_COLORS[health])} />
      </IconButton>
      {open && (
        <div className="absolute bottom-full right-0 mb-2 w-80 z-50 rounded-lg border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 shadow-lg p-4 text-sm text-bolt-elements-textPrimary">
          <div className="flex items-center justify-between mb-3">
            <span className="font-medium">Context</span>
            <div className="flex items-center gap-2">
              <span className={classNames('inline-block w-2.5 h-2.5 rounded-full', DOT_COLORS[health])} />
              <IconButton title="Close" className="transition-all" onClick={() => contextPanelOpen.set(false)}>
                <div className="i-ph:x text-base" />
              </IconButton>
            </div>
          </div>
          <div className="space-y-1.5 text-xs">
            <div className="flex justify-between">
              <span className="text-bolt-elements-textSecondary">Conversation re-sent each turn</span>
              <span>
                {stats.historyMessages}
                {stats.maxTurns > 0 ? `/${stats.maxTurns}` : ''} msgs · ~{formatTokens(historyTokens)} tok
              </span>
            </div>
            {stats.attachments > 0 && (
              <div className="flex justify-between">
                <span className="text-bolt-elements-textSecondary">Attachments re-sent each turn</span>
                <span>
                  {stats.attachments} · ~{formatTokens(stats.attachmentTokens)} tok
                </span>
              </div>
            )}
            <div className="flex justify-between">
              <span className="text-bolt-elements-textSecondary">Cached prefix read (0.1x)</span>
              <span>{formatTokens(stats.cacheReadTokens)} tok</span>
            </div>
            <div className="flex justify-between">
              <span className="text-bolt-elements-textSecondary">Uncached input (1x)</span>
              <span>{formatTokens(stats.promptTokens)} tok</span>
            </div>
            <div className="flex justify-between">
              <span className="text-bolt-elements-textSecondary">Cache writes (2x)</span>
              <span>{formatTokens(stats.cacheCreationTokens)} tok</span>
            </div>
            <div className="flex justify-between">
              <span className="text-bolt-elements-textSecondary">Output last turn</span>
              <span>{formatTokens(stats.completionTokens)} tok</span>
            </div>
            <div className="flex justify-between">
              <span className="text-bolt-elements-textSecondary">Last turn cost</span>
              <span>{stats.creditsCharged} credits</span>
            </div>
            {stats.model && (
              <div className="flex justify-between">
                <span className="text-bolt-elements-textSecondary">Model</span>
                <span>{stats.model}</span>
              </div>
            )}
            {/*
             * WHICH GATEWAY SERVED IT. Directly under the model, because with `AUTO_MODEL_SELECT` the two
             * are independent: the platform picks a gateway per turn from a preference ladder, and the
             * SAME model bills materially differently on each (measured: Premium settled 1,017 credits on
             * Anthropic against ~407 at KIE-shaped rates). Without this the cost line above can move
             * between two identical-looking turns with nothing on screen explaining why.
             */}
            {stats.provider && (
              <div className="flex justify-between">
                <span className="text-bolt-elements-textSecondary">Provider</span>
                <span>{stats.provider}</span>
              </div>
            )}
            {/*
             * WHAT THE GATEWAY SAVED, IN CREDITS (`billing/savings.ts`).
             *
             * Credits are cost-proportional, so a cheaper gateway is not our margin — it is the user's
             * pack going further, and it was previously invisible: the cost line above moved between two
             * identical-looking turns with nothing explaining it. Directly under that line, because it
             * only means anything as a comparison against the number it discounts.
             *
             * `full_price` is rendered, not hidden. A row that appears only when there IS a discount
             * teaches the user that its absence means "unknown", when the honest reading of an Anthropic
             * turn is "there was no cheaper option today" — and silence there would let a discount be
             * implied by omission on every turn that did not get one.
             */}
            {stats.savings && (
              <div className="flex justify-between">
                <span className="text-bolt-elements-textSecondary">Saved vs full price</span>
                {stats.savings.basis === 'saved' ? (
                  <span className="text-bolt-elements-icon-success">{formatSavings(stats.savings)}</span>
                ) : (
                  <span className="text-bolt-elements-textTertiary">full price</span>
                )}
              </div>
            )}
            {/*
             * The session's thinking effort (§4.2.9) — it belongs in the cost report because thinking bills
             * as OUTPUT at the full rate, so a raised floor is the one setting here that moves every future
             * turn's price. Clickable: the report is where a user notices the cost, which is where they will
             * want the control.
             */}
            <button
              type="button"
              className="flex justify-between w-full text-left hover:text-bolt-elements-textPrimary"
              onClick={() => {
                contextPanelOpen.set(false);
                effortPanelOpen.set(true);
              }}
            >
              <span className="text-bolt-elements-textSecondary">Thinking effort</span>
              <span className="underline decoration-dotted underline-offset-2">{EFFORT_LABELS[effort]}</span>
            </button>
          </div>
          <div className="mt-3 pt-2 border-t border-bolt-elements-borderColor text-xs text-bolt-elements-textSecondary">
            {HEALTH_ADVICE[health]}
          </div>
        </div>
      )}
    </div>
  );
}
