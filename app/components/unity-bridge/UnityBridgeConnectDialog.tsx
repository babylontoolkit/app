/**
 * The Unity Connect dialog (SPEC §4.17, D7, D42, D43, D52).
 *
 * Its FIRST section is always the shared Local scenes section — local scenes never wait on the bridge
 * (D52). With the bridge disabled (D43) that is the only section. Otherwise the four bridge sections
 * follow: run the helper, approve its pairing code, manage devices, link this project.
 *
 * The helper command is printed with `window.location.origin` — no app URL is hardcoded anywhere (D42,
 * the branding rule).
 */
import { useState } from 'react';
import { useStore } from '@nanostores/react';
import { toast } from 'react-toastify';
import { LocalScenesSection } from '~/components/local-scenes/LocalScenesSection';
import { ConfirmationDialog, Dialog, DialogButton, DialogClose, DialogRoot, DialogTitle } from '~/components/ui/Dialog';
import {
  approvePairingCode,
  bridgeDialogStore,
  bridgeProjectAction,
  bridgeStatusStore,
  refreshBridgeStatus,
  revokeDevice,
  type BridgeStatusView,
} from '~/lib/stores/unity-bridge';

export const BRIDGE_INPUT_CLASS =
  'w-full px-3 py-1.5 rounded-md border border-bolt-elements-borderColor bg-bolt-elements-prompt-background text-bolt-elements-textPrimary text-sm';

const SMALL_BUTTON =
  'shrink-0 px-2.5 py-1 rounded-md text-xs border border-bolt-elements-borderColor bg-bolt-elements-background-depth-3 text-bolt-elements-textPrimary hover:bg-bolt-elements-item-backgroundActive disabled:opacity-50';

const SECTION_HEADING = 'text-sm font-medium text-bolt-elements-textPrimary';

type Device = BridgeStatusView['devices'][number];

const pageOrigin = () => (typeof window === 'undefined' ? '' : window.location.origin);

function describeLastSeen(device: Device): string {
  if (device.online) {
    return 'online';
  }

  if (!device.lastSeenAt) {
    return 'never seen';
  }

  const at = new Date(device.lastSeenAt);

  return Number.isNaN(at.getTime()) ? 'last seen earlier' : `last seen ${at.toLocaleString()}`;
}

export function UnityBridgeConnectDialog({ projectId }: { projectId: string }) {
  const dialog = useStore(bridgeDialogStore);
  const status = useStore(bridgeStatusStore);

  const [code, setCode] = useState('');
  const [approving, setApproving] = useState(false);
  const [approveError, setApproveError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<Device | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);

  const open = dialog === 'connect';
  const enabled = status?.enabled ?? true;
  const devices = status?.devices ?? [];
  const onlineDevices = devices.filter((device) => device.online);
  const onlineHelperDevServer = onlineDevices.find((device) => device.hello?.devServer)?.hello?.devServer;

  const origin = pageOrigin();
  const command = `npx @babylonjs-toolkit/agent bridge --server ${origin}`;

  const copyCommand = async () => {
    try {
      await navigator.clipboard.writeText(command);
      toast.success('Copied');
    } catch {
      toast.error('Could not copy — select the command and copy it by hand.');
    }
  };

  const approve = async () => {
    setApproving(true);
    setApproveError(null);

    const result = await approvePairingCode(code.trim());

    setApproving(false);

    if (!result.ok) {
      setApproveError(result.message ?? 'Could not approve that code.');
      return;
    }

    setCode('');
    toast.success(`Paired ${result.message ?? 'your computer'}`);
    await refreshBridgeStatus(projectId);
  };

  const confirmRemove = async () => {
    const device = removing;
    setRemoving(null);

    if (!device) {
      return;
    }

    const result = await revokeDevice(device.id);

    if (!result.ok) {
      toast.error(result.message ?? 'Could not remove that device.');
    }

    await refreshBridgeStatus(projectId);
  };

  const link = async (deviceId: string, unityProjectKey: string) => {
    setLinkError(null);

    const result = await bridgeProjectAction(projectId, { action: 'link', deviceId, unityProjectKey });

    if (!result.ok) {
      setLinkError(result.message ?? 'Could not link that project.');
      return;
    }

    await refreshBridgeStatus(projectId);
  };

  return (
    <DialogRoot open={open} onOpenChange={(next) => !next && bridgeDialogStore.set(null)}>
      <Dialog className="max-w-[520px] p-6 max-h-[85vh] overflow-y-auto">
        <DialogTitle>Unity scenes</DialogTitle>

        <div className="space-y-5 mt-4">
          <section className="space-y-2">
            <div>
              <div className={SECTION_HEADING}>Use scenes from your Unity dev server</div>
              <div className="text-xs text-bolt-elements-textSecondary">No bridge needed.</div>
            </div>
            <LocalScenesSection projectId={projectId} helperDevServer={onlineHelperDevServer} />
          </section>

          {enabled && (
            <>
              <hr className="border-bolt-elements-borderColor" />

              <section className="space-y-2">
                <div className={SECTION_HEADING}>Run the helper on the computer that has Unity</div>
                <div className="flex gap-2 items-start">
                  <pre className="flex-1 text-xs bg-bolt-elements-background-depth-3 text-bolt-elements-textPrimary rounded-md p-3 overflow-x-auto">
                    {command}
                  </pre>
                  <button type="button" className={SMALL_BUTTON} onClick={() => void copyCommand()}>
                    Copy
                  </button>
                </div>
                <div className="text-xs text-bolt-elements-textTertiary">
                  Already have the Desktop Agent? <code>{`bt-agent bridge --server ${origin}`}</code>
                </div>
                <div className="text-xs text-bolt-elements-textSecondary">
                  Run it inside your Unity project folder, or add --unity &lt;path&gt;.
                </div>
              </section>

              <section className="space-y-2">
                <label htmlFor="unity-bridge-pairing-code" className={SECTION_HEADING}>
                  Pairing code
                </label>
                <div className="flex gap-2 items-center">
                  <input
                    id="unity-bridge-pairing-code"
                    value={code}
                    onChange={(event) => setCode(event.target.value)}
                    placeholder="XXXX-XXXX"
                    autoComplete="off"
                    className={BRIDGE_INPUT_CLASS}
                  />
                  <DialogButton type="primary" onClick={() => void approve()} disabled={approving || !code.trim()}>
                    {approving ? 'Approving…' : 'Approve'}
                  </DialogButton>
                </div>
                {approveError && <div className="text-xs text-bolt-elements-icon-error">{approveError}</div>}
              </section>

              <section className="space-y-2">
                <div className={SECTION_HEADING}>Your devices</div>
                {devices.length === 0 ? (
                  <div className="text-xs text-bolt-elements-textSecondary">No computers are paired yet.</div>
                ) : (
                  <div className="flex flex-col gap-1">
                    {devices.map((device) => (
                      <div
                        key={device.id}
                        className="flex items-center gap-2 px-2 py-1.5 rounded-md border border-bolt-elements-borderColor text-xs"
                      >
                        <span
                          className={
                            device.online
                              ? 'i-ph:check-circle text-green-500'
                              : 'i-ph:circle text-bolt-elements-textTertiary'
                          }
                        />
                        <div className="flex-1 min-w-0 truncate text-bolt-elements-textPrimary">
                          {device.name} · {device.os} · {describeLastSeen(device)}
                        </div>
                        <button type="button" className={SMALL_BUTTON} onClick={() => setRemoving(device)}>
                          Remove
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              <section className="space-y-2">
                <div className={SECTION_HEADING}>Link this project</div>
                {onlineDevices.length === 0 ? (
                  <div className="text-xs text-bolt-elements-textSecondary">
                    Start the helper on a paired computer to see its Unity projects here.
                  </div>
                ) : (
                  onlineDevices.map((device) => (
                    <div key={device.id} className="space-y-1">
                      <div className="flex flex-wrap gap-2">
                        {(device.hello?.unityProjects ?? []).map((project) => (
                          <button
                            key={project.key}
                            type="button"
                            className={SMALL_BUTTON}
                            onClick={() => void link(device.id, project.key)}
                          >
                            {`Link ${project.name} on ${device.name}`}
                          </button>
                        ))}
                      </div>
                      <div className="text-xs text-bolt-elements-textTertiary">
                        {device.hello?.blender
                          ? `Blender ${device.hello.blender.version} found`
                          : 'Blender not found — add --blender <path> if you use it'}
                      </div>
                    </div>
                  ))
                )}
                {linkError && <div className="text-xs text-bolt-elements-icon-error">{linkError}</div>}
              </section>
            </>
          )}
        </div>

        <div className="flex justify-end gap-2 mt-6">
          <DialogClose asChild>
            <DialogButton type="secondary">Close</DialogButton>
          </DialogClose>
        </div>

        <ConfirmationDialog
          isOpen={removing !== null}
          onClose={() => setRemoving(null)}
          onConfirm={() => void confirmRemove()}
          title={`Remove ${removing?.name ?? 'this device'}?`}
          description={`Remove ${removing?.name ?? 'this device'}? The helper on that computer will stop working until it is paired again.`}
          confirmLabel="Remove"
          variant="destructive"
        />
      </Dialog>
    </DialogRoot>
  );
}
