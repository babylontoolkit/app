/**
 * Settings → Features → "Projects folder" (SPEC §4.5.4d).
 *
 * The one place the parent folder is chosen, changed or forgotten. Every string comes from
 * `describeLocalProject`, and the card offers exactly the ONE action that description names — a card
 * with three buttons for four states is how a user ends up pressing "Change" on a browser that cannot
 * pick a folder at all.
 */
import { memo, useState } from 'react';
import { motion } from 'framer-motion';
import { useStore } from '@nanostores/react';
import { toast } from 'react-toastify';
import { classNames } from '~/utils/classNames';
import {
  chooseProjectsFolder,
  describeLocalProject,
  disconnectProjectsFolder,
  localProjectState,
  reconnectProjectsFolder,
} from '~/lib/local-project';

const ACTION_LABEL = { choose: 'Choose a folder…', reconnect: 'Reconnect', change: 'Change folder…' } as const;

export const ProjectsFolderCard = memo(() => {
  const state = useStore(localProjectState);
  const view = describeLocalProject(state);
  const [busy, setBusy] = useState(false);

  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);

    try {
      await work();
    } catch (error) {
      toast.error(`Could not update your projects folder: ${error instanceof Error ? error.message : 'unknown error'}`);
    } finally {
      setBusy(false);
    }
  };

  const act = () => {
    switch (view.action) {
      case 'choose':
      case 'change':
        return run(async () => {
          if (await chooseProjectsFolder()) {
            toast.success('Projects you open from now on are kept in that folder.');
          }
        });
      case 'reconnect':
        return run(reconnectProjectsFolder);
      default:
        return undefined;
    }
  };

  const toneClass = {
    quiet: 'text-bolt-elements-textSecondary',
    info: 'text-bolt-elements-textSecondary',
    warn: 'text-amber-500',
    error: 'text-bolt-elements-icon-error',
  }[view.tone];

  return (
    <motion.div
      className={classNames('relative bg-bolt-elements-background-depth-2', 'rounded-lg overflow-hidden')}
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
    >
      <div className="p-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className="i-ph:folder-open w-5 h-5 shrink-0 text-bolt-elements-textSecondary" />
            <h4 className="font-medium text-bolt-elements-textPrimary truncate">{view.headline}</h4>
          </div>
          {view.action && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void act()}
              className="shrink-0 rounded-md border border-bolt-elements-borderColor px-3 py-1.5 text-sm text-bolt-elements-textPrimary hover:bg-bolt-elements-background-depth-3 disabled:opacity-60"
            >
              {ACTION_LABEL[view.action]}
            </button>
          )}
        </div>
        <p className={classNames('mt-2 text-sm', toneClass)}>{view.detail}</p>
        {(state.kind === 'connected' || state.kind === 'needs-permission') && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void run(disconnectProjectsFolder)}
            className="mt-3 text-xs text-bolt-elements-textTertiary hover:text-bolt-elements-textSecondary"
          >
            Stop using this folder (nothing on disk is deleted)
          </button>
        )}
      </div>
    </motion.div>
  );
});
