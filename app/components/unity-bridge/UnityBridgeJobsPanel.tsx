/**
 * The project's Unity Bridge jobs (SPEC §4.17). Opens when `bridgeDialogStore === 'jobs'`.
 *
 * Live rows (streamed by the current generation) come first, then the recent rows from the status
 * route, deduped by job id. Rows mirror the Media panel's list rows. No credits on a row: bridge
 * operations are not billed separately — the model turn that drives them is (D53).
 *
 * A finished `unity_capture` shows its picture as a thumbnail (click → full size), so the user sees what
 * the model was shown. The image lives only in the live store (memory) — a reload shows the row without it.
 */
import { useState } from 'react';
import { useStore } from '@nanostores/react';
import { toast } from 'react-toastify';
import { Dialog, DialogButton, DialogClose, DialogRoot, DialogTitle } from '~/components/ui/Dialog';
import type { BridgeJobStatus } from '~/lib/bridge/protocol';
import {
  bridgeDialogStore,
  bridgeLiveJobsStore,
  type BridgeJobImage,
  bridgeProjectAction,
  bridgeStatusStore,
  refreshBridgeStatus,
} from '~/lib/stores/unity-bridge';

interface JobRow {
  id: string;
  operation: string;
  status: BridgeJobStatus;
  lastLine?: string;
  resultText?: string;
  image?: BridgeJobImage;
}

const imageSrc = (image: BridgeJobImage) => `data:${image.mimeType};base64,${image.base64}`;

const ACTIVE: ReadonlySet<BridgeJobStatus> = new Set(['queued', 'running']);

function statusIcon(status: BridgeJobStatus): string {
  if (status === 'succeeded') {
    return 'i-ph:check-circle text-green-500';
  }

  if (ACTIVE.has(status)) {
    return 'i-svg-spinners:90-ring-with-bg text-bolt-elements-textSecondary';
  }

  return 'i-ph:x-circle text-red-500';
}

export function UnityBridgeJobsPanel({ projectId }: { projectId: string }) {
  const dialog = useStore(bridgeDialogStore);
  const live = useStore(bridgeLiveJobsStore);
  const status = useStore(bridgeStatusStore);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [zoomed, setZoomed] = useState<string | null>(null);

  const rows: JobRow[] = [];
  const seen = new Set<string>();

  for (const [id, job] of Object.entries(live)) {
    seen.add(id);
    rows.push({ id, operation: job.label, status: job.status, lastLine: job.lines.at(-1), image: job.image });
  }

  for (const job of status?.jobs ?? []) {
    if (seen.has(job.id)) {
      continue;
    }

    seen.add(job.id);
    rows.push({
      id: job.id,
      operation: job.operation,
      status: job.status,
      lastLine: job.error,
      resultText: job.resultText,
    });
  }

  const cancel = async (jobId: string) => {
    const result = await bridgeProjectAction(projectId, { action: 'cancelJob', jobId });

    if (!result.ok) {
      toast.error(result.message ?? 'Could not cancel that job.');
    }

    await refreshBridgeStatus(projectId);
  };

  const zoomedImage = zoomed ? rows.find((row) => row.id === zoomed)?.image : undefined;

  return (
    <DialogRoot
      open={dialog === 'jobs'}
      onOpenChange={(next) => {
        if (!next) {
          setZoomed(null);
          bridgeDialogStore.set(null);
        }
      }}
    >
      <Dialog
        className={
          zoomedImage
            ? // `!`: the shared Dialog sets `w-[520px]`, and stylesheet order — not class order — decides a tie.
              '!w-[1080px] max-w-[calc(100vw-32px)] p-6 max-h-[90vh] overflow-y-auto'
            : 'max-w-[520px] p-6 max-h-[85vh] overflow-y-auto'
        }
      >
        <DialogTitle>Unity jobs</DialogTitle>

        {zoomedImage && (
          <button
            type="button"
            data-testid="bridge-job-image-full"
            title="Back to the list"
            className="mt-4 block w-full overflow-auto rounded-md border border-bolt-elements-borderColor bg-transparent p-0 cursor-zoom-out"
            onClick={() => setZoomed(null)}
          >
            <img src={imageSrc(zoomedImage)} alt="Unity capture, full size" className="block max-w-none mx-auto" />
          </button>
        )}

        <div className="flex flex-col gap-1 mt-4">
          {rows.length === 0 && <div className="text-sm text-bolt-elements-textSecondary">No Unity jobs yet.</div>}
          {rows.map((row) => (
            <div
              key={row.id}
              data-testid="bridge-job-row"
              className="flex flex-col gap-1 px-2 py-1.5 rounded-md border border-bolt-elements-borderColor text-xs"
            >
              <div className="flex items-center gap-2">
                <span className={statusIcon(row.status)} />
                <div className="flex-1 min-w-0">
                  <div className="text-bolt-elements-textPrimary truncate">{row.operation}</div>
                  <div className="text-bolt-elements-textTertiary truncate">
                    {row.status}
                    {row.lastLine ? ` · ${row.lastLine}` : ''}
                  </div>
                </div>
                {ACTIVE.has(row.status) && (
                  <button
                    type="button"
                    className="px-2 py-0.5 rounded bg-bolt-elements-background-depth-3 text-bolt-elements-textSecondary"
                    onClick={() => void cancel(row.id)}
                  >
                    Cancel
                  </button>
                )}
                {row.resultText && (
                  <button
                    type="button"
                    className="px-2 py-0.5 rounded bg-bolt-elements-background-depth-3 text-bolt-elements-textSecondary"
                    onClick={() => setExpanded(expanded === row.id ? null : row.id)}
                  >
                    {expanded === row.id ? 'Hide' : 'Result'}
                  </button>
                )}
              </div>
              {row.image && (
                <button
                  type="button"
                  data-testid="bridge-job-thumbnail"
                  title="Show full size"
                  className="self-start p-0 bg-transparent rounded border border-bolt-elements-borderColor overflow-hidden cursor-zoom-in"
                  onClick={() => setZoomed(row.id)}
                >
                  <img src={imageSrc(row.image)} alt={`${row.operation} capture`} className="block h-24 w-auto" />
                </button>
              )}
              {expanded === row.id && row.resultText && (
                <pre className="text-xs bg-bolt-elements-background-depth-3 text-bolt-elements-textPrimary rounded-md p-2 overflow-x-auto whitespace-pre-wrap max-h-60">
                  {row.resultText}
                </pre>
              )}
            </div>
          ))}
        </div>

        <div className="flex justify-end gap-2 mt-6">
          <DialogClose asChild>
            <DialogButton type="secondary">Close</DialogButton>
          </DialogClose>
        </div>
      </Dialog>
    </DialogRoot>
  );
}
