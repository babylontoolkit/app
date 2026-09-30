import { memo, useState } from 'react';
import type { ActivityRow, ActivityState } from '~/lib/agent-workspace/activity';
import type { TodoItem } from '~/lib/agent/workspace-protocol-types';
import { classNames } from '~/utils/classNames';

/**
 * The tool loop's live activity (tool-loop plan D20): the agent's todo checklist, then one row per
 * workspace tool call — "Writing …" → "Wrote …", "Running …" → "Ran …", "Checking your game…" →
 * passed / problems with a thumbnail. Rendered above the message text.
 *
 * Class strings live HERE (a `.tsx`) on purpose: UnoCSS only scans `.ts` via an explicit include, and
 * a class that exists only in a `.ts` module is a class that silently does not exist.
 */

export const VISIBLE_ROWS = 6;

const KIND_ICON: Record<ActivityRow['kind'], string> = {
  write: 'i-ph:file-code',
  run: 'i-ph:terminal-window',
  check: 'i-ph:game-controller',
};

function TodoIcon({ status }: { status: TodoItem['status'] }) {
  if (status === 'completed') {
    return <div className="i-ph:check-square text-bolt-elements-icon-success" />;
  }

  if (status === 'in_progress') {
    return <div className="i-svg-spinners:90-ring-with-bg text-bolt-elements-loader-progress" />;
  }

  return <div className="i-ph:square text-bolt-elements-textTertiary" />;
}

function RowIcon({ row }: { row: ActivityRow }) {
  if (row.status === 'running') {
    return <div className="i-svg-spinners:90-ring-with-bg text-bolt-elements-loader-progress" />;
  }

  if (row.status === 'failed') {
    return <div className="i-ph:x-circle text-bolt-elements-icon-error" />;
  }

  return <div className={classNames(KIND_ICON[row.kind], 'text-bolt-elements-icon-success')} />;
}

/** "Wrote `src/x.ts`" → the backticked subject rendered as inline code, like the artifact rows. */
function RowLabel({ label }: { label: string }) {
  const parts = label.split('`');

  return (
    <span className="min-w-0 break-words">
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <code
            key={i}
            className="bg-bolt-elements-artifacts-inlineCode-background text-bolt-elements-artifacts-inlineCode-text px-1.5 py-0.5 rounded-md"
          >
            {part}
          </code>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </span>
  );
}

export const WorkspaceActivity = memo(({ state }: { state: ActivityState }) => {
  const [showAll, setShowAll] = useState(false);
  const { rows, todos } = state;
  const hidden = showAll ? 0 : Math.max(0, rows.length - VISIBLE_ROWS);
  const visible = rows.slice(hidden);

  return (
    <div
      className="workspace-activity mb-3 border border-bolt-elements-borderColor rounded-lg overflow-hidden bg-bolt-elements-actions-background"
      data-testid="workspace-activity"
    >
      {todos.length > 0 && (
        <ul className="list-none space-y-1.5 px-5 py-3.5 border-b border-bolt-elements-artifacts-borderColor">
          {todos.map((todo, i) => (
            <li key={i} className="flex items-center gap-1.5 text-sm" data-status={todo.status}>
              <div className="text-lg shrink-0">
                <TodoIcon status={todo.status} />
              </div>
              <span
                className={classNames(
                  todo.status === 'completed'
                    ? 'text-bolt-elements-textTertiary line-through'
                    : 'text-bolt-elements-textPrimary',
                )}
              >
                {todo.content}
              </span>
            </li>
          ))}
        </ul>
      )}
      {rows.length > 0 && (
        <ul className="list-none space-y-2.5 px-5 py-3.5">
          {hidden > 0 && (
            <li>
              <button
                type="button"
                onClick={() => setShowAll(true)}
                className="text-xs text-bolt-elements-textSecondary hover:text-bolt-elements-textPrimary bg-transparent"
              >
                Show all {rows.length}
              </button>
            </li>
          )}
          {visible.map((row) => (
            <li key={row.toolCallId} className="text-sm" data-status={row.status}>
              <div className="flex items-center gap-1.5 text-bolt-elements-textPrimary">
                <div className="text-lg shrink-0">
                  <RowIcon row={row} />
                </div>
                <RowLabel label={row.label} />
              </div>
              {row.screenshotDataUrl && (
                <img
                  src={row.screenshotDataUrl}
                  alt="Screenshot of the game check"
                  className="mt-2 ml-6 w-[160px] rounded-md border border-bolt-elements-borderColor"
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
});
