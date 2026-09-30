/**
 * The Unity capture popup (SPEC §4.17, D55) — replaces the Jobs panel's thumbnail.
 *
 * Opens when a `bridge-job` part carrying a capture image arrives (`bridgeCaptureStore`, set by
 * `updateBridgeFromPart`), so the USER sees what the model was shown — the model's tool text says
 * "(The user sees this capture in a popup, not in the chat.)". It never opens over a pending consent
 * prompt: the store holds the capture back until the prompt closes. Clicking the picture toggles full
 * size; Close dismisses it. Memory only — the picture is never persisted or re-fetched.
 */
import { useEffect, useState } from 'react';
import { useStore } from '@nanostores/react';
import { Dialog, DialogButton, DialogRoot, DialogTitle } from '~/components/ui/Dialog';
import { bridgeCaptureStore } from '~/lib/stores/unity-bridge';

/**
 * The popup's subtitle: the view in plain words, never the tool label (verifier, 2026-09-29) —
 * `unity_capture game 1024x576` → "Game view · 1024×576", `unity_capture scene` → "Scene view". Any other label
 * is shown as it is.
 */
export function captureSubtitle(label: string): string {
  const match = /^unity_capture (game|scene)(?: (\d+)x(\d+))?$/.exec(label.trim());

  if (!match) {
    return label;
  }

  const view = match[1] === 'scene' ? 'Scene view' : 'Game view';

  return match[2] ? `${view} · ${match[2]}×${match[3]}` : view;
}

export function UnityCapturePopup() {
  const capture = useStore(bridgeCaptureStore);
  const [full, setFull] = useState(false);

  // A new capture always opens fitted.
  useEffect(() => setFull(false), [capture?.jobId, capture?.image.base64]);

  if (!capture) {
    return null;
  }

  const src = `data:${capture.image.mimeType};base64,${capture.image.base64}`;
  const close = () => bridgeCaptureStore.set(null);

  return (
    <DialogRoot open onOpenChange={(next) => !next && close()}>
      <Dialog className={full ? '!w-[95vw] p-6' : '!w-[640px] max-w-[95vw] p-6'} onClose={close}>
        <DialogTitle>Unity capture</DialogTitle>
        {capture.label && (
          <div className="text-xs text-bolt-elements-textTertiary mt-1">{captureSubtitle(capture.label)}</div>
        )}

        <button
          type="button"
          data-testid="bridge-capture-image"
          title={full ? 'Fit to the window' : 'Show full size'}
          className={full ? 'mt-4 block max-h-[75vh] overflow-auto' : 'mt-4 block'}
          onClick={() => setFull((value) => !value)}
        >
          <img
            src={src}
            alt={capture.label ? captureSubtitle(capture.label) : 'Unity capture'}
            className={full ? 'max-w-none' : 'max-w-full max-h-[60vh] rounded-md'}
          />
        </button>

        <div className="flex justify-end gap-2 mt-6">
          <DialogButton type="secondary" onClick={close}>
            Close
          </DialogButton>
        </div>
      </Dialog>
    </DialogRoot>
  );
}
