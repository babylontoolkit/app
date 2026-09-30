/**
 * The paired Unity device's status (SPEC §4.17, D38, D52, D54). Opens when `bridgeDialogStore ===
 * 'status'` — i.e. a device is paired and it is online or offline. The device shown is the one the agent
 * drives: the most recently seen present one (the server decides, `pickBridgeDevice`).
 *
 * There is NO project link (D54): the panel shows the helper's projects folder and the Unity projects in
 * it read-only (the agent opens or creates one with `unity_project`), and "Allow scripts" is a switch on
 * the DEVICE, posted with its id. There is no Unlink.
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
  const device = status?.device ?? null;
  const hello = device?.hello;
  const current = hello?.currentProject;
  const projects = hello?.unityProjects ?? [];
  const unityProject = current ? projects.find((project) => project.name === current) : undefined;
  const toolkitVersion = unityProject?.toolkitVersion;
  const allowScripts = device?.allowScripts ?? false;

  // An offline device's stored hello may predate the folder report — say so, rather than "—".
  const missingProjectsDir = device?.online ? '—' : 'unknown until the helper reconnects';

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
              {device?.name ?? 'Unknown device'} ·{' '}
              <span className={device?.online ? 'text-green-500' : 'text-bolt-elements-textTertiary'}>
                {device?.online ? 'online' : 'offline'}
              </span>
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

          <section className="space-y-2">
            <div className={SECTION_HEADING}>Unity projects</div>
            {hello ? (
              <>
                <div className="text-xs text-bolt-elements-textSecondary">
                  Projects folder{' '}
                  {hello.projectsDir ? (
                    <span className="font-mono">{hello.projectsDir}</span>
                  ) : (
                    <span data-testid="projects-dir-unknown">{missingProjectsDir}</span>
                  )}
                  . The agent opens or creates the Unity project it works on.
                </div>
                {projects.length === 0 ? (
                  <div className="text-xs text-bolt-elements-textTertiary">No Unity projects in this folder yet.</div>
                ) : (
                  <ul className="text-sm space-y-0.5" aria-label="Unity projects">
                    {projects.map((project) => (
                      <li key={project.key} className="text-bolt-elements-textPrimary">
                        {project.name}
                        {project.name === current && (
                          <span className="ml-2 text-xs text-green-500" data-testid="current-project">
                            current
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </>
            ) : (
              <div className="text-xs text-bolt-elements-textTertiary">
                The helper has not reported its projects yet — start it on this computer.
              </div>
            )}
          </section>

          <section className="space-y-1">
            <label className="flex items-center gap-2 text-sm text-bolt-elements-textPrimary">
              <input
                type="checkbox"
                checked={allowScripts}
                disabled={busy || !device}
                onChange={(event) => {
                  if (device) {
                    void act({ action: 'allowScripts', deviceId: device.id, value: event.target.checked });
                  }
                }}
              />
              Allow scripts
            </label>
            <div className="text-xs text-bolt-elements-textSecondary">
              Lets the agent run C# in Unity and Python in Blender on this computer.
            </div>
          </section>

          <section className="space-y-2">
            <div className={SECTION_HEADING}>Local scene server</div>
            <LocalScenesSection projectId={projectId} helperDevServer={hello?.devServer} />
          </section>

          <section className="space-y-2">
            <div className={SECTION_HEADING}>Jobs</div>
            <DialogButton type="secondary" onClick={() => bridgeDialogStore.set('jobs')}>
              View jobs
            </DialogButton>
          </section>
        </div>

        <div className="flex justify-end gap-2 mt-6">
          <DialogButton type="secondary" onClick={() => bridgeDialogStore.set('connect')}>
            Manage devices
          </DialogButton>
          <DialogClose asChild>
            <DialogButton type="secondary">Close</DialogButton>
          </DialogClose>
        </div>
      </Dialog>
    </DialogRoot>
  );
}
