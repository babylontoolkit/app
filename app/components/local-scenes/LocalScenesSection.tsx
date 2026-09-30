/**
 * Import scenes from the user's local Unity dev server (D22, D27, D52).
 *
 * ONE component, rendered in both the Unity Connect dialog (first section) and the Status panel, so the
 * controls are one click away in every bridge state — including no bridge at all. It therefore imports
 * nothing from the bridge store: the origin helpers live in `~/lib/local-scenes/origin`, and the scene
 * list (only ever known from an online helper's report) arrives as a prop.
 */
import { useState } from 'react';
import { toast } from 'react-toastify';
import { ConfirmationDialog, DialogButton } from '~/components/ui/Dialog';
import { checkDevServer, type DevServerState } from '~/lib/local-scenes/devserver';
import { FILES_EXIST_PREFIX, importLocalScene } from '~/lib/local-scenes/import';
import { readLocalSceneServer, saveLocalSceneServer } from '~/lib/local-scenes/origin';
import { sceneNameFromUrl } from '~/lib/local-scenes/url';
import { LOCAL_SCENE_EXPLAINER_COPY } from './explainer-copy';

const INPUT_CLASS =
  'w-full px-3 py-1.5 rounded-md border border-bolt-elements-borderColor bg-bolt-elements-prompt-background text-bolt-elements-textPrimary text-sm';

const SMALL_BUTTON =
  'shrink-0 px-2.5 py-1 rounded-md text-xs border border-bolt-elements-borderColor bg-bolt-elements-background-depth-3 text-bolt-elements-textPrimary hover:bg-bolt-elements-item-backgroundActive disabled:opacity-50';

const DEFAULT_ORIGIN = 'http://localhost:8888';

const RUNNING_TEXT = 'The scene server is running and this site can read from it.';

export interface LocalScenesSectionProps {
  projectId: string;
  helperDevServer?: { origin?: string; scenes?: string[] };
}

const trimOrigin = (value: string) => value.trim().replace(/\/+$/, '');

export function LocalScenesSection({ projectId, helperDevServer }: LocalScenesSectionProps) {
  const [origin, setOrigin] = useState(
    () => helperDevServer?.origin ?? readLocalSceneServer(projectId) ?? DEFAULT_ORIGIN,
  );
  const [check, setCheck] = useState<DevServerState | null>(null);
  const [checking, setChecking] = useState(false);
  const [freeUrl, setFreeUrl] = useState('');
  const [busyUrl, setBusyUrl] = useState<string | null>(null);
  const [pendingOverwrite, setPendingOverwrite] = useState<string | null>(null);

  const base = trimOrigin(origin) || DEFAULT_ORIGIN;
  const scenes = helperDevServer?.scenes ?? [];

  const save = () => {
    saveLocalSceneServer(projectId, trimOrigin(origin));
    toast.success('Saved');
  };

  const runCheck = async () => {
    setChecking(true);

    try {
      setCheck(await checkDevServer(base));
    } finally {
      setChecking(false);
    }
  };

  const runImport = async (url: string, overwrite: boolean) => {
    setBusyUrl(url);

    try {
      const result = await importLocalScene({ url, overwrite });

      if (!result.ok && !overwrite && result.message.startsWith(FILES_EXIST_PREFIX)) {
        setPendingOverwrite(url);
        return;
      }

      if (result.ok) {
        toast.success(result.message);
      } else {
        toast.error(result.message);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyUrl(null);
    }
  };

  const checkText =
    check === null ? null : check === 'running' ? RUNNING_TEXT : LOCAL_SCENE_EXPLAINER_COPY[check].title;

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <label htmlFor={`local-scene-origin-${projectId}`} className="text-xs text-bolt-elements-textSecondary">
          Dev server address
        </label>
        <div className="flex gap-2 items-center">
          <input
            id={`local-scene-origin-${projectId}`}
            aria-label="Dev server address"
            value={origin}
            onChange={(event) => {
              setOrigin(event.target.value);
              setCheck(null);
            }}
            placeholder={DEFAULT_ORIGIN}
            className={INPUT_CLASS}
          />
          <button type="button" className={SMALL_BUTTON} onClick={save}>
            Save
          </button>
          <button type="button" className={SMALL_BUTTON} onClick={() => void runCheck()} disabled={checking}>
            {checking ? 'Checking…' : 'Check'}
          </button>
        </div>
        {checkText && (
          <div
            data-testid="local-scene-check"
            className={check === 'running' ? 'text-xs text-green-500' : 'text-xs text-bolt-elements-icon-error'}
          >
            {checkText}
          </div>
        )}
      </div>

      {scenes.length > 0 ? (
        <div className="flex flex-col gap-1">
          {scenes.map((scene) => {
            const url = `${base}/scenes/${scene}`;

            return (
              <div
                key={scene}
                className="flex items-center gap-2 px-2 py-1.5 rounded-md border border-bolt-elements-borderColor text-xs"
              >
                <span className="i-ph:cube-duotone text-bolt-elements-textSecondary" />
                <span className="flex-1 min-w-0 truncate text-bolt-elements-textPrimary">{scene}</span>
                <button
                  type="button"
                  className={SMALL_BUTTON}
                  disabled={busyUrl !== null}
                  onClick={() => void runImport(url, false)}
                >
                  {busyUrl === url ? 'Importing…' : 'Import to project'}
                </button>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="text-xs text-bolt-elements-textSecondary">
          Paste a scene URL from your Unity dev server, e.g. <code>{`${base}/scenes/Level01.gltf`}</code>. No bridge
          needed.
        </p>
      )}

      <div className="flex gap-2 items-center">
        <input
          aria-label="Scene URL"
          value={freeUrl}
          onChange={(event) => setFreeUrl(event.target.value)}
          placeholder={`${base}/scenes/Level01.gltf`}
          className={INPUT_CLASS}
        />
        <DialogButton
          type="primary"
          disabled={!freeUrl.trim() || busyUrl !== null}
          onClick={() => void runImport(freeUrl.trim(), false)}
        >
          Import
        </DialogButton>
      </div>

      <ConfirmationDialog
        isOpen={pendingOverwrite !== null}
        onClose={() => setPendingOverwrite(null)}
        onConfirm={() => {
          const url = pendingOverwrite;
          setPendingOverwrite(null);

          if (url) {
            void runImport(url, true);
          }
        }}
        title="Replace existing files?"
        description={`Replace the existing files in public/scenes/${
          pendingOverwrite ? sceneNameFromUrl(pendingOverwrite) : ''
        }/?`}
        confirmLabel="Replace"
        variant="destructive"
      />
    </div>
  );
}
