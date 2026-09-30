/**
 * THE Unity Bridge dialog (SPEC §4.17, D55) — one screen, replacing Connect / Status / Jobs / Local scenes.
 *
 * Owner, 2026-09-29: "all the other elements on the Unity Bridge screen are not needed… just the INFO to
 * tell how to install the bridge service if it's not already running; if running, some status info like
 * Unity CLI ready and Blender CLI ready."
 *
 *   - Not online → ONE command with a freshly minted single-use install code built in:
 *       npx @babylonjs-toolkit/agent bridge --install-service --pair XXXX-XXXX [--server <this origin>]
 *     `--server` is added only when this page is not the production origin the server reports — the
 *     helper defaults to production (no app URL is hardcoded here, the branding rule). The code is minted
 *     when the install view shows and re-minted ~30 s before it expires; while open, the status is polled
 *     every 3 s and the dialog switches to the running view when the helper comes online.
 *   - Online → what the helper reports: Unity CLI, Blender, Babylon Toolkit, projects folder, current
 *     project, computer — and the per-computer **Allow scripts** checkbox (D58, on by default). Toggling
 *     posts `/api/bridge/devices {action:'allowScripts'}`; a failure toasts the server's sentence and the box
 *     goes back. With `--no-scripts` on the helper the box is disabled beside the muted line (that
 *     computer's own switch wins). A "Show install command" link reveals the install view (another
 *     computer, or a re-pair).
 *   - Offline (paired, not running) → the install view, prefixed with what is wrong.
 *   - Disabled → one sentence.
 *
 * Removed on purpose (D55): the devices list, the Jobs panel (captures open `UnityCapturePopup`), and the
 * Local scenes section (import goes through the agent). The consent prompt is a separate dialog and is unchanged.
 */
import { useEffect, useRef, useState } from 'react';
import { useStore } from '@nanostores/react';
import { toast } from 'react-toastify';
import { Dialog, DialogButton, DialogClose, DialogRoot, DialogTitle } from '~/components/ui/Dialog';
import { BRIDGE_TOOLKIT_MIN_VERSION } from '~/lib/bridge/protocol';
import {
  bridgeDialogStore,
  bridgeStatusStore,
  mintInstallCode,
  refreshBridgeStatus,
  setBridgeAllowScripts,
  type BridgeStatusView,
} from '~/lib/stores/unity-bridge';

/** How often the open dialog re-reads the status (to notice the helper coming online). */
export const DIALOG_STATUS_POLL_MS = 3_000;

/** A code is replaced this long before it expires, so a copied command is never seconds from dead. */
export const REMINT_BEFORE_EXPIRY_MS = 30_000;

const SMALL_BUTTON =
  'shrink-0 px-2.5 py-1 rounded-md text-xs border border-bolt-elements-borderColor bg-bolt-elements-background-depth-3 text-bolt-elements-textPrimary hover:bg-bolt-elements-item-backgroundActive disabled:opacity-50';

const LINK_BUTTON = 'text-xs text-bolt-elements-textSecondary underline hover:text-bolt-elements-textPrimary';

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

/**
 * The one install command. `--server` only when this page is not the production origin (the helper's
 * default); an unknown production origin (null) always names the server.
 */
export function installCommand(code: string, pageOrigin: string, productionOrigin: string | null): string {
  const base = `npx @babylonjs-toolkit/agent bridge --install-service --pair ${code}`;

  return productionOrigin === pageOrigin ? base : `${base} --server ${pageOrigin}`;
}

const pageOrigin = () => (typeof window === 'undefined' ? '' : window.location.origin);

type Invite = { code: string; expiresAt: string } | { error: string } | null;

function InstallView({
  status,
  active,
  offlineName,
}: {
  status: BridgeStatusView | null;
  active: boolean;
  offlineName?: string;
}) {
  const [invite, setInvite] = useState<Invite>(null);
  const [attempt, setAttempt] = useState(0);

  // Mint when the view shows, and again whenever a retry is asked for.
  useEffect(() => {
    if (!active) {
      return undefined;
    }

    let cancelled = false;

    setInvite(null);
    void mintInstallCode().then((result) => {
      if (!cancelled) {
        setInvite(result.ok ? { code: result.code, expiresAt: result.expiresAt } : { error: result.message });
      }
    });

    return () => {
      cancelled = true;
    };
  }, [active, attempt]);

  // Re-mint ~30 s before the code expires.
  useEffect(() => {
    if (!active || !invite || !('code' in invite)) {
      return undefined;
    }

    const due = Date.parse(invite.expiresAt) - REMINT_BEFORE_EXPIRY_MS - Date.now();
    const timer = setTimeout(() => setAttempt((n) => n + 1), Math.max(0, Number.isFinite(due) ? due : 0));

    return () => clearTimeout(timer);
  }, [active, invite]);

  // A code that was just claimed (unpaired → paired) is spent: mint a fresh one for the next computer.
  const lastState = useRef(status?.state);

  useEffect(() => {
    const previous = lastState.current;
    lastState.current = status?.state;

    if (active && previous === 'unpaired' && status?.state === 'offline') {
      setAttempt((n) => n + 1);
    }
  }, [active, status?.state]);

  const command =
    invite && 'code' in invite ? installCommand(invite.code, pageOrigin(), status?.productionOrigin ?? null) : null;

  const copyCommand = async () => {
    if (!command) {
      return;
    }

    try {
      await navigator.clipboard.writeText(command);
      toast.success('Copied');
    } catch {
      toast.error('Could not copy — select the command and copy it by hand.');
    }
  };

  return (
    <div className="space-y-3">
      {offlineName !== undefined && (
        <p className="text-sm text-bolt-elements-textPrimary" data-testid="bridge-offline-line">
          {`"${offlineName}" is paired but the helper isn't running. Start it again with the command below (it also re-installs the service).`}
        </p>
      )}
      <p className="text-sm text-bolt-elements-textSecondary">
        Run this once in a terminal on the computer that has Unity. It installs a small helper that starts with your
        computer, so the AI can open, edit and export your Unity projects.
      </p>

      {invite && 'error' in invite ? (
        <div className="flex gap-2 items-start">
          <div className="flex-1 text-xs text-bolt-elements-icon-error" data-testid="bridge-invite-error">
            {invite.error}
          </div>
          <button type="button" className={SMALL_BUTTON} onClick={() => setAttempt((n) => n + 1)}>
            Try again
          </button>
        </div>
      ) : (
        <div className="flex gap-2 items-start">
          <pre
            data-testid="bridge-install-command"
            className="flex-1 text-xs bg-bolt-elements-background-depth-3 text-bolt-elements-textPrimary rounded-md p-3 overflow-x-auto whitespace-pre-wrap break-all"
          >
            {command ?? 'Creating your install command…'}
          </pre>
          <button type="button" className={SMALL_BUTTON} disabled={!command} onClick={() => void copyCommand()}>
            Copy
          </button>
        </div>
      )}

      <p className="text-xs text-bolt-elements-textTertiary">
        Run it inside your Unity projects folder, or add --projects &lt;folder&gt;.
      </p>
    </div>
  );
}

function StatusRow({ label, value, ok }: { label: string; value: string; ok: boolean }) {
  return (
    <li className="flex items-start gap-2 text-sm" data-testid="bridge-status-row">
      <span
        aria-label={ok ? 'ready' : 'missing'}
        className={
          ok ? 'i-ph:check-circle text-green-500 mt-0.5' : 'i-ph:x-circle text-bolt-elements-icon-error mt-0.5'
        }
      />
      <span className="w-[120px] shrink-0 text-bolt-elements-textTertiary">{label}</span>
      <span className="flex-1 min-w-0 break-words text-bolt-elements-textPrimary">{value}</span>
    </li>
  );
}

/**
 * The per-computer Allow scripts switch (D58). The box shows the user's choice at once; a refusal from the
 * server puts it back and toasts the server's own sentence.
 */
function AllowScriptsToggle({
  projectId,
  deviceId,
  allowScripts,
  disabledLocally,
}: {
  projectId: string;
  deviceId: string;
  allowScripts: boolean;
  disabledLocally: boolean;
}) {
  const [pending, setPending] = useState<boolean | null>(null);
  const checked = pending ?? allowScripts;

  const change = async (value: boolean) => {
    setPending(value);

    const result = await setBridgeAllowScripts(deviceId, value);

    if (result.ok) {
      // Show the saved value now; the refresh then confirms it from the server.
      const current = bridgeStatusStore.get();

      if (current?.device?.id === deviceId) {
        bridgeStatusStore.set({ ...current, device: { ...current.device, allowScripts: value } });
      }

      void refreshBridgeStatus(projectId);
    } else {
      toast.error(result.message ?? 'Could not change Allow scripts.');
    }

    setPending(null);
  };

  return (
    <label className="flex items-start gap-2 text-sm text-bolt-elements-textPrimary">
      <input
        type="checkbox"
        className="mt-0.5"
        checked={checked}
        disabled={disabledLocally || pending !== null}
        onChange={(event) => void change(event.target.checked)}
      />
      <span>
        Allow scripts
        <span className="block text-xs text-bolt-elements-textTertiary">
          Lets the AI run C# in Unity and Python in Blender on this computer.
        </span>
      </span>
    </label>
  );
}

function OnlineView({ status, projectId }: { status: BridgeStatusView; projectId: string }) {
  const device = status.device;
  const hello = device?.hello;
  const current = hello?.currentProject;
  const currentInfo = current ? hello?.unityProjects.find((project) => project.name === current) : undefined;
  const toolkitVersion = currentInfo?.toolkitVersion;
  const toolkitOld = toolkitVersion ? isVersionBelow(toolkitVersion, BRIDGE_TOOLKIT_MIN_VERSION) : false;

  return (
    <div className="space-y-3">
      <ul className="space-y-1.5" aria-label="Unity Bridge status">
        <StatusRow
          label="Unity CLI"
          value={hello?.unityCli?.version ?? 'not found'}
          ok={Boolean(hello?.unityCli?.version)}
        />
        <StatusRow
          label="Blender"
          value={hello?.blender?.version ?? 'not found — add --blender <path> to the install command'}
          ok={Boolean(hello?.blender?.version)}
        />
        <StatusRow label="Babylon Toolkit" value={toolkitVersion ?? '—'} ok={Boolean(toolkitVersion) && !toolkitOld} />
        <StatusRow label="Projects folder" value={hello?.projectsDir || '—'} ok={Boolean(hello?.projectsDir)} />
        <StatusRow
          label="Current project"
          value={current ?? 'none — ask the AI to open or create one'}
          ok={Boolean(current)}
        />
        <StatusRow label="Computer" value={device?.name ?? '—'} ok={Boolean(device?.name)} />
      </ul>

      {toolkitOld && (
        <div className="text-xs px-3 py-2 rounded-md bg-amber-500/10 text-amber-600">
          {`Babylon Toolkit ${toolkitVersion} is older than ${BRIDGE_TOOLKIT_MIN_VERSION} — export commands will be refused until you update it.`}
        </div>
      )}

      {device?.id && (
        <AllowScriptsToggle
          projectId={projectId}
          deviceId={device.id}
          allowScripts={device.allowScripts !== false}
          disabledLocally={hello?.scriptsDisabledLocally === true}
        />
      )}

      {hello?.scriptsDisabledLocally && (
        <p className="text-xs text-bolt-elements-textTertiary">Scripts are disabled on this computer (--no-scripts).</p>
      )}
    </div>
  );
}

export function UnityBridgeDialog({ projectId }: { projectId: string }) {
  const dialog = useStore(bridgeDialogStore);
  const status = useStore(bridgeStatusStore);
  const [showInstall, setShowInstall] = useState(false);

  const open = dialog === 'bridge';
  const enabled = status?.enabled ?? true;
  const online = enabled && status?.state === 'online';
  const offline = enabled && status?.state === 'offline';
  const installVisible = open && enabled && (!online || showInstall);

  // While open, poll the status so the dialog notices the helper coming online.
  useEffect(() => {
    if (!open || !enabled) {
      return undefined;
    }

    const timer = setInterval(() => void refreshBridgeStatus(projectId), DIALOG_STATUS_POLL_MS);

    return () => clearInterval(timer);
  }, [open, enabled, projectId]);

  // The helper just came online while the user was looking at the install command.
  const waitingForHelper = useRef(false);

  useEffect(() => {
    if (!open) {
      waitingForHelper.current = false;
      return;
    }

    if (!online) {
      waitingForHelper.current = true;
      return;
    }

    if (waitingForHelper.current) {
      waitingForHelper.current = false;
      setShowInstall(false);
      toast.success('Unity Bridge connected');
    }
  }, [open, online]);

  // Each opening starts on its own view.
  useEffect(() => {
    if (!open) {
      setShowInstall(false);
    }
  }, [open]);

  const title = !enabled ? 'Unity Bridge' : online ? 'Unity Bridge connected' : 'Connect Unity and Blender';

  return (
    <DialogRoot open={open} onOpenChange={(next) => !next && bridgeDialogStore.set(null)}>
      <Dialog className="max-w-[560px] p-6 max-h-[85vh] overflow-y-auto">
        <DialogTitle>{title}</DialogTitle>

        <div className="space-y-4 mt-4">
          {!enabled ? (
            <p className="text-sm text-bolt-elements-textSecondary">The Unity Bridge is turned off on this server.</p>
          ) : (
            <>
              {online && status && <OnlineView status={status} projectId={projectId} />}

              {online && !showInstall && (
                <button type="button" className={LINK_BUTTON} onClick={() => setShowInstall(true)}>
                  Show install command
                </button>
              )}

              {(!online || showInstall) && (
                <InstallView
                  status={status}
                  active={installVisible}
                  offlineName={offline ? (status?.device?.name ?? 'Your computer') : undefined}
                />
              )}
            </>
          )}
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
