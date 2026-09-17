/**
 * The one mounted projects-folder panel (SPEC §4.5.4d).
 *
 * 🔴 **It renders a REQUEST, and never decides for itself.** `runFolderGate` (`workspace-gate.ts`)
 * decides, from the two doors into a workspace — creating a project and opening one — and publishes
 * what to show. This component has no route test, no timer and no view of the disk state, which is the
 * whole correction of 2026-09-17: the gate used to be a cover over a list of paths including `/`, so it
 * met people on the front page of the app builder, before there was any project for a folder to hold.
 *
 * It is opaque and `z-max`, over the sidebar too, unlike `WorkspaceSplash` (which stays beneath it so a
 * stalled boot is never a trap). The difference is that nothing is stalling here: the user is being
 * asked a question and both ways out are on the panel — answer it, or leave the workspace unopened.
 *
 * The buttons ARE the user gestures the browser demands: `showDirectoryPicker` and `requestPermission`
 * both refuse outside a click, which is why this can never be an automatic prompt.
 */
import { useStore } from '@nanostores/react';
import { useState } from 'react';
import {
  cancelFolderGate,
  chooseProjectsFolder,
  folderGateCopy,
  folderGateRequest,
  grantFolderAccess,
  skipFolderGate,
  type FolderGateRequest,
} from '~/lib/local-project';

export interface FolderGatePanelProps {
  request: FolderGateRequest;
  onChoose: () => Promise<void>;
  onReconnect: () => Promise<void>;
  onSkip: () => void;
  onCancel: () => void;
}

/** The surface, with every decision taken as a prop — so a test can draw each state without a browser. */
export function FolderGatePanel({ request, onChoose, onReconnect, onSkip, onCancel }: FolderGatePanelProps) {
  const copy = folderGateCopy(request);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);

    try {
      await work();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'unknown error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-max flex items-center justify-center px-6 bg-bolt-elements-background-depth-1"
      data-testid="projects-folder-gate"
    >
      {request.gate === 'checking' ? (
        <div className="flex flex-col items-center gap-4" role="status" aria-live="polite">
          <div
            className="i-svg-spinners:90-ring-with-bg text-bolt-elements-loader-progress text-4xl"
            aria-hidden="true"
          />
          <div className="text-lg font-medium text-bolt-elements-textPrimary">{copy.title}</div>
        </div>
      ) : (
        <div className="flex max-w-md flex-col items-center gap-4 text-center" role="dialog" aria-modal="true">
          <div className="i-ph:folder-open text-4xl text-bolt-elements-textSecondary" aria-hidden="true" />
          <div>
            <div className="text-lg font-medium text-bolt-elements-textPrimary">{copy.title}</div>
            <div className="mt-1 text-sm text-bolt-elements-textSecondary">{copy.detail}</div>
          </div>
          <div className="flex flex-wrap items-center justify-center gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => void run(request.gate === 'choose' ? onChoose : onReconnect)}
              className="rounded-md bg-bolt-elements-button-primary-background px-4 py-2 text-sm text-bolt-elements-button-primary-text hover:bg-bolt-elements-button-primary-backgroundHover disabled:opacity-60"
            >
              {copy.primary}
            </button>
            {copy.alternate && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void run(onChoose)}
                className="rounded-md border border-bolt-elements-borderColor px-4 py-2 text-sm text-bolt-elements-textSecondary hover:bg-bolt-elements-background-depth-3 disabled:opacity-60"
              >
                {copy.alternate}
              </button>
            )}
            {/* Exactly one of these exists: `skip` opens the workspace anyway, `cancel` abandons it. */}
            {copy.skip && (
              <button
                type="button"
                disabled={busy}
                onClick={onSkip}
                className="rounded-md px-4 py-2 text-sm text-bolt-elements-textTertiary hover:text-bolt-elements-textSecondary disabled:opacity-60"
              >
                {copy.skip}
              </button>
            )}
            {copy.cancel && (
              <button
                type="button"
                disabled={busy}
                onClick={onCancel}
                className="rounded-md px-4 py-2 text-sm text-bolt-elements-textTertiary hover:text-bolt-elements-textSecondary disabled:opacity-60"
              >
                {copy.cancel}
              </button>
            )}
          </div>
          {error && (
            <div className="text-sm text-bolt-elements-icon-error" role="alert">
              Could not set up your projects folder: {error}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The wiring.
 *
 * Choosing or reconnecting closes the gate WITHOUT this component saying so: both write the disk state,
 * which `runFolderGate` is subscribed to, so it re-decides and resolves the door's promise. A picker the
 * user dismissed writes nothing, so the gate simply stays — which is the correct answer to "I opened the
 * file dialog and changed my mind".
 */
export function ProjectsFolderGate() {
  const request = useStore(folderGateRequest);

  if (!request) {
    return null;
  }

  return (
    <FolderGatePanel
      request={request}
      onChoose={async () => {
        await chooseProjectsFolder();
      }}
      onReconnect={async () => {
        await grantFolderAccess();
      }}
      onSkip={skipFolderGate}
      onCancel={cancelFolderGate}
    />
  );
}
