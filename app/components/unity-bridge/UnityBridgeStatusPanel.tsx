/**
 * The linked Unity device's status (SPEC §4.17, D38, D52). Opens when `bridgeDialogStore === 'status'`
 * — i.e. the project is linked and its device is online or offline.
 *
 * Its Local scene server section is the SAME `LocalScenesSection` the Connect dialog renders (D52),
 * never a second copy of those controls.
 */
import { useState } from 'react';
import { useStore } from '@nanostores/react';
import { toast } from 'react-toastify';
import { LocalScenesSection } from '~/components/local-scenes/LocalScenesSection';
import { Dialog, DialogButton, DialogClose, DialogRoot, DialogTitle } from '~/components/ui/Dialog';
import { BRIDGE_TOOLKIT_MIN_VERSION } from '~/lib/bridge/protocol';
import {
  bridgeDialogStore,
  bridgeProjectAction,
  bridgeStatusStore,
  refreshBridgeStatus,
} from '~/lib/stores/unity-bridge';

const SECTION_HEADING = 'text-sm font-medium text-bolt-elements-textPrimary';

/** Numeric major.minor.patch compare; anything unparseable compares as 0. */
export function isVersionBelow(version: string, minimum: string): boolean {
  const parts = (value: string) =>
    value
      .split(/[.+-]/)
      .slice(0, 3)
      .map((part) => Number.parseInt(part, 10))
      .map((n) => (Number.isFinite(n) ? n : 0));
  const a = parts(version);
  const b = parts(minimum);

  for (let i = 0; i < 3; i++) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;

    if (left !== right) {
      return left < right;
    }
  }

  return false;
}

export function UnityBridgeStatusPanel({ projectId }: { projectId: string }) {
  const dialog = useStore(bridgeDialogStore);
  const status = useStore(bridgeStatusStore);
  const [busy, setBusy] = useState(false);

  const open = dialog === 'status';
  const linkedDevice = status?.devices.find((device) => device.id === status.link?.deviceId);
  const hello = linkedDevice?.hello;
  const unityProject = hello?.unityProjects?.[0];
  const toolkitVersion = unityProject?.toolkitVersion;
  const allowScripts = status?.link?.allowScripts ?? false;

  const act = async (body: Record<string, unknown>) => {
    setBusy(true);

    const result = await bridgeProjectAction(projectId, body);

    setBusy(false);

    if (!result.ok) {
      toast.error(result.message ?? 'That did not work.');
    }

    await refreshBridgeStatus(projectId);

    return result.ok;
  };

  const versions: Array<[string, string | undefined]> = [
    ['Unity CLI', hello?.unityCli?.version],
    ['Unity', unityProject?.unityVersion],
    ['Toolkit', toolkitVersion],
    ['Pipeline', unityProject?.pipelineVersion],
    ['Blender', hello?.blender?.version],
  ];

  return (
    <DialogRoot open={open} onOpenChange={(next) => !next && bridgeDialogStore.set(null)}>
      <Dialog className="max-w-[520px] p-6 max-h-[85vh] overflow-y-auto">
        <DialogTitle>Unity Bridge</DialogTitle>

        <div className="space-y-5 mt-4">
          <section className="space-y-2">
            <div className={SECTION_HEADING}>Device</div>
            <div className="text-sm text-bolt-elements-textSecondary">
              {status?.link?.deviceName ?? linkedDevice?.name ?? 'Unknown device'} ·{' '}
              <span className={linkedDevice?.online ? 'text-green-500' : 'text-bolt-elements-textTertiary'}>
                {linkedDevice?.online ? 'online' : 'offline'}
              </span>
              {status?.link?.unityProjectName ? ` · ${status.link.unityProjectName}` : ''}
            </div>
            <div className="grid grid-cols-[100px_1fr] gap-x-3 gap-y-0.5 text-xs">
              {versions.map(([label, value]) => (
                <div key={label} className="contents">
                  <div className="text-bolt-elements-textTertiary">{label}</div>
                  <div className="text-bolt-elements-textPrimary">{value ?? '—'}</div>
                </div>
              ))}
            </div>
            {toolkitVersion && isVersionBelow(toolkitVersion, BRIDGE_TOOLKIT_MIN_VERSION) && (
              <div className="text-xs px-3 py-2 rounded-md bg-amber-500/10 text-amber-600">
                {`Babylon Toolkit ${toolkitVersion} is older than ${BRIDGE_TOOLKIT_MIN_VERSION} — export commands will be refused until you update it.`}
              </div>
            )}
          </section>

          <section className="space-y-1">
            <label className="flex items-center gap-2 text-sm text-bolt-elements-textPrimary">
              <input
                type="checkbox"
                checked={allowScripts}
                disabled={busy}
                onChange={(event) => void act({ action: 'allowScripts', value: event.target.checked })}
              />
              Allow scripts
            </label>
            <div className="text-xs text-bolt-elements-textSecondary">
              Lets the agent run C# in Unity and Python in Blender on your machine.
            </div>
          </section>

          <section className="space-y-2">
            <div className={SECTION_HEADING}>Local scene server</div>
            <LocalScenesSection projectId={projectId} helperDevServer={linkedDevice?.hello?.devServer} />
          </section>

          <section className="space-y-2">
            <div className={SECTION_HEADING}>Jobs</div>
            <DialogButton type="secondary" onClick={() => bridgeDialogStore.set('jobs')}>
              View jobs
            </DialogButton>
          </section>
        </div>

        <div className="flex justify-between gap-2 mt-6">
          <DialogButton
            type="danger"
            disabled={busy}
            onClick={() => {
              void act({ action: 'unlink' }).then((ok) => ok && bridgeDialogStore.set('connect'));
            }}
          >
            Unlink
          </DialogButton>
          <div className="flex gap-2">
            <DialogButton type="secondary" onClick={() => bridgeDialogStore.set('connect')}>
              Manage devices
            </DialogButton>
            <DialogClose asChild>
              <DialogButton type="secondary">Close</DialogButton>
            </DialogClose>
          </div>
        </div>
      </Dialog>
    </DialogRoot>
  );
}
