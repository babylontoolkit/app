/**
 * The "Connect Unity Exporter" toolbar icon + dialog (SPEC §4.17).
 *
 * "Unity Exporter" is the owner's name for the Unity-side toolchain and is what every user-facing
 * string here says. The internal wiring keeps the bare `unity` identifier — it is the reserved MCP
 * server label that routes tool calls end-to-end (§4.17), not a display name, and renaming it would
 * silently break routing.
 *
 * Pairs this browser with the Unity bridge companion running on the user's own machine. The
 * connection is per-MACHINE (a port and a token on this computer), so it lives in localStorage and is
 * never written into the project — unlike a Game Backend, it does not travel with a remix.
 *
 * Nothing here auto-connects: the pairing token is minted fresh by each companion run, so a saved
 * pairing prefills the form but the user still presses Connect. A stale token silently failing in the
 * background would look exactly like the feature being broken.
 */
import { useCallback, useEffect, useState } from 'react';
import { useStore } from '@nanostores/react';
import { toast } from 'react-toastify';
import { classNames } from '~/utils/classNames';
import { Dialog, DialogRoot, DialogClose, DialogTitle, DialogButton } from '~/components/ui/Dialog';
import { IconButton } from '~/components/ui/IconButton';
import {
  connectUnity,
  disconnectUnity,
  loadPersistedUnityConnection,
  unityConnectionAtom,
  unityToolsAtom,
} from '~/lib/stores/unityBridge';
import { projectId as projectIdStore } from '~/lib/persistence';
import { sessionStore } from '~/lib/stores/session';
import {
  UNITY_LICENSE_PATH,
  WEB_LICENSE_PATH,
  downloadLicense,
  dropLicenseIntoUnity,
  writeLicenseToWebProject,
  type UnityLicense,
} from '~/lib/unity/license-delivery';

const COMPANION_COMMAND = 'npx @babylonjs-toolkit/bridge';
const DEFAULT_PORT = '8080';

export function UnityConnection() {
  const connection = useStore(unityConnectionAtom);
  const tools = useStore(unityToolsAtom);
  const activeProjectId = useStore(projectIdStore);

  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [port, setPort] = useState(DEFAULT_PORT);
  const [token, setToken] = useState('');

  // Prefill from the last pairing on this machine (never auto-connect — see the module note).
  useEffect(() => {
    const saved = loadPersistedUnityConnection();

    if (saved) {
      setPort(String(saved.port));
      setToken(saved.token ?? '');
    }
  }, []);

  const isConnected = connection.status === 'connected';
  const isConnecting = connection.status === 'connecting';

  const handleConnect = async () => {
    const connected = await connectUnity(Number(port), token || undefined);

    if (connected) {
      setIsDialogOpen(false);
    }
  };

  const handleDisconnect = async () => {
    await disconnectUnity(true);
    setIsDialogOpen(false);
  };

  return (
    <>
      {/*
       * Icon-only, in the prompt toolbar alongside the other tool icons. The connection STATE is
       * carried by colour + tooltip rather than a label — with no text there is nothing else to say
       * it, so the tooltip names the state and the tool count explicitly.
       */}
      <div className="relative">
        <div className="flex">
          <IconButton
            onClick={() => setIsDialogOpen(!isDialogOpen)}
            title={
              isConnected
                ? `Unity Exporter connected — ${tools.length} tool${tools.length === 1 ? '' : 's'}`
                : 'Connect your Unity Exporter'
            }
            className={classNames('transition-all', isConnected ? 'text-bolt-elements-icon-success' : '')}
          >
            {isConnecting ? (
              <div className="i-svg-spinners:90-ring-with-bg text-bolt-elements-loader-progress text-xl animate-spin" />
            ) : (
              <div className="i-ph:cube-duotone text-xl" />
            )}
          </IconButton>
        </div>
      </div>

      <DialogRoot open={isDialogOpen} onOpenChange={setIsDialogOpen}>
        <Dialog className="max-w-[520px] p-6 max-h-[85vh] overflow-y-auto">
          <DialogTitle>Connect your Unity Exporter</DialogTitle>

          <div className="space-y-4 mt-4">
            <p className="text-sm text-bolt-elements-textSecondary">
              Run the bridge on this computer, with your Unity Exporter open, then paste the port and pairing token it
              prints. The assistant can then drive it using your credits. The connection is local-only — Unity must be
              on the same machine you are browsing from.
            </p>

            <pre className="text-xs bg-bolt-elements-background-depth-3 text-bolt-elements-textPrimary rounded-md p-3 overflow-x-auto">
              {COMPANION_COMMAND}
            </pre>

            {isConnected ? (
              <div className="text-sm text-bolt-elements-textSecondary">
                Connected on port {connection.port} — {tools.length} Unity tool{tools.length === 1 ? '' : 's'} available
                in this chat.
              </div>
            ) : (
              <div className="grid grid-cols-[120px_1fr] gap-3 items-center">
                <label htmlFor="unity-port" className="text-sm text-bolt-elements-textSecondary">
                  Port
                </label>
                <input
                  id="unity-port"
                  value={port}
                  onChange={(e) => setPort(e.target.value)}
                  placeholder={DEFAULT_PORT}
                  className="w-full px-3 py-1.5 rounded-md border border-bolt-elements-borderColor bg-bolt-elements-prompt-background text-bolt-elements-textPrimary text-sm"
                />

                <label htmlFor="unity-token" className="text-sm text-bolt-elements-textSecondary">
                  Pairing token
                </label>
                <input
                  id="unity-token"
                  type="password"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder="Printed by the companion"
                  className="w-full px-3 py-1.5 rounded-md border border-bolt-elements-borderColor bg-bolt-elements-prompt-background text-bolt-elements-textPrimary text-sm"
                />
              </div>
            )}

            {connection.status === 'error' && (
              <div className="text-sm text-bolt-elements-icon-error space-y-1">
                <div>Could not connect: {connection.message}</div>
                <div className="text-bolt-elements-textSecondary">
                  Check that the bridge is running (<code>{COMPANION_COMMAND}</code>){' '}
                  <strong>on this same computer</strong> — the connection is local-only, so Unity must be open on the
                  machine you are browsing from — and that the port and token match what it printed. Local connections
                  work in Chrome and Edge; Safari and Firefox may block them.
                </div>
              </div>
            )}
          </div>

          <div className="flex justify-end gap-2 mt-6">
            <DialogClose asChild>
              <DialogButton type="secondary">Close</DialogButton>
            </DialogClose>

            {isConnected ? (
              <DialogButton type="danger" onClick={handleDisconnect}>
                Disconnect
              </DialogButton>
            ) : (
              <DialogButton type="primary" onClick={handleConnect} disabled={isConnecting || !port}>
                {isConnecting ? 'Connecting…' : 'Connect'}
              </DialogButton>
            )}
          </div>

          {/*
           * Unity Project License (SPEC §4.18). A distinct section beneath the connect/pair controls.
           * It only exists with an active project (the link is stored on the project record), and it is
           * independent of the bridge connection — linking + generating work with Unity disconnected;
           * the bridge only enables the best-effort drop into the open editor.
           */}
          {activeProjectId && <UnityLicenseSection projectId={activeProjectId} isConnected={isConnected} />}
        </Dialog>
      </DialogRoot>
    </>
  );
}

interface LicenseTierOffer {
  tier: 'Indie' | 'SmallBusiness' | 'PremiumContent';
  label: string;
  credits: number;
  seats: { s1: string; s2: string };

  /** True when this (Unity project, tier) was already paid for — re-generation is then free. */
  unlocked: boolean;
}

interface LicenseStatus {
  linkedUnityProjectId: string | null;
  tiers: LicenseTierOffer[];
}

/** Per-tier seat/email explanation shown under the picker. */
function tierExplanation(offer: LicenseTierOffer, email: string): string {
  switch (offer.tier) {
    case 'SmallBusiness':
      return 'Two blank, editable seats — add teammate emails directly in license.json after generating.';
    case 'PremiumContent':
      return 'Unlimited seats.';
    default:
      return `Issued to your account email${
        email ? ` (${email})` : ''
      }. Your Unity account email must match this App Builder email; paid tiers can hand-add seat emails.`;
  }
}

type DropState = { status: 'ok' } | { status: 'failed'; reason: string } | { status: 'skipped' } | null;

/**
 * The license link + tier picker + generate/download UI. Kept as its own component so it mounts only with
 * an active project and its state (linked id, chosen tier, generated license, drop outcome) never leaks
 * into the connect flow.
 */
export function UnityLicenseSection({ projectId, isConnected }: { projectId: string; isConnected: boolean }) {
  const session = useStore(sessionStore);
  const email = session.user?.email ?? '';

  const [status, setStatus] = useState<LicenseStatus | null>(null);
  const [idInput, setIdInput] = useState('');
  const [tier, setTier] = useState<LicenseTierOffer['tier']>('Indie');
  const [linkBusy, setLinkBusy] = useState(false);
  const [genBusy, setGenBusy] = useState(false);
  const [license, setLicense] = useState<UnityLicense | null>(null);
  const [drop, setDrop] = useState<DropState>(null);

  const route = `/api/projects/${projectId}/unity-license`;

  const refresh = useCallback(() => {
    fetch(route)
      .then((r) => (r.ok ? (r.json() as Promise<LicenseStatus>) : null))
      .then((data) => data && setStatus(data))
      .catch(() => undefined);
  }, [route]);

  useEffect(refresh, [refresh]);

  const linked = status?.linkedUnityProjectId ?? null;
  const tiers = status?.tiers ?? [];
  const selected = tiers.find((t) => t.tier === tier) ?? tiers[0];

  const link = async () => {
    setLinkBusy(true);

    try {
      const r = await fetch(route, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'link', unityProjectId: idInput.trim() }),
      });
      const data = (await r.json()) as { ok?: boolean; message?: string };

      if (!r.ok || !data.ok) {
        toast.error(data.message ?? 'Could not link the Unity project.');
        return;
      }

      toast.success('Unity project linked.');
      setIdInput('');
      refresh();
    } finally {
      setLinkBusy(false);
    }
  };

  const unlink = async () => {
    setLinkBusy(true);

    try {
      const r = await fetch(route, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'unlink' }),
      });
      const data = (await r.json()) as { ok?: boolean; message?: string };

      if (!r.ok || !data.ok) {
        toast.error(data.message ?? 'Could not unlink the Unity project.');
        return;
      }

      // Unlink clears the link only — it never deletes the license.json already in the project.
      toast.success('Unity project unlinked.');
      setLicense(null);
      setDrop(null);
      refresh();
    } finally {
      setLinkBusy(false);
    }
  };

  const generate = async () => {
    setGenBusy(true);
    setDrop(null);

    try {
      const r = await fetch(route, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'generate', tier }),
      });
      const data = (await r.json()) as {
        license?: UnityLicense;
        credits?: number;
        alreadyUnlocked?: boolean;
        message?: string;
      };

      if (!r.ok || !data.license) {
        toast.error(data.message ?? 'Could not generate the license.');
        return;
      }

      const lic = data.license;
      setLicense(lic);

      // What the charge was — the credit debit is the exact number the button showed.
      const charge =
        data.alreadyUnlocked || !data.credits
          ? 'no charge — already unlocked'
          : `${data.credits.toLocaleString()} credits`;

      const written = await writeLicenseToWebProject(lic);

      if (!written) {
        toast.error('Generated the license, but could not write license.json into the project.');
      }

      if (isConnected) {
        const result = await dropLicenseIntoUnity(lic);

        if (result.ok) {
          setDrop({ status: 'ok' });
          toast.success(`${lic.plan} license (${charge}) generated and dropped into Unity.`);
        } else {
          setDrop({ status: 'failed', reason: result.reason });
          toast.info(`${lic.plan} license generated (${charge}) — add it to Unity manually (see below).`);
        }
      } else {
        // Disconnected is not an error: the file is in the web project; show manual instructions, quietly.
        setDrop({ status: 'skipped' });
        toast.success(`${lic.plan} license (${charge}) generated and saved to /${WEB_LICENSE_PATH}.`);
      }

      // Reflect the new unlock (this tier is now free to re-generate).
      refresh();
    } finally {
      setGenBusy(false);
    }
  };

  const inputStyle =
    'w-full px-3 py-1.5 rounded-md border border-bolt-elements-borderColor bg-bolt-elements-prompt-background text-bolt-elements-textPrimary text-sm';

  const generateLabel = genBusy
    ? 'Generating…'
    : !selected
      ? 'Generate License'
      : selected.unlocked
        ? 'Re-generate — free'
        : `Generate — ${selected.credits.toLocaleString()} credits`;

  return (
    <div className="mt-6 pt-5 border-t border-bolt-elements-borderColor space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-bolt-elements-textPrimary">Pro Tools License</h3>
        <p className="text-xs text-bolt-elements-textSecondary mt-1">
          Link this app to your Unity project, then generate a project-locked <code>license.json</code> that unlocks the
          Unity Exporter Pro Tools for it. Each tier is a one-time credit charge — once you unlock a tier for a project
          it never expires and re-downloads are free.
        </p>
      </div>

      {linked ? (
        <div className="flex items-center justify-between gap-3 rounded-md bg-bolt-elements-background-depth-2 px-3 py-2">
          <div className="min-w-0">
            <div className="text-xs text-bolt-elements-textSecondary">Linked Unity Project ID</div>
            <div className="text-sm font-mono text-bolt-elements-textPrimary truncate">{linked}</div>
          </div>
          <button
            onClick={() => void unlink()}
            disabled={linkBusy}
            className="shrink-0 px-3 py-1.5 text-sm rounded-md border border-bolt-elements-borderColor text-bolt-elements-textSecondary hover:bg-bolt-elements-background-depth-3 disabled:opacity-50"
          >
            Unlink
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          <label htmlFor="unity-project-id" className="block text-xs text-bolt-elements-textSecondary">
            Unity Project ID — Unity → Edit → Project Settings → the 32-character <code>productGUID</code> (also in{' '}
            <code>ProjectSettings/ProjectSettings.asset</code>).
          </label>
          <div className="flex gap-2">
            <input
              id="unity-project-id"
              value={idInput}
              onChange={(e) => setIdInput(e.target.value)}
              placeholder="e.g. 5f3c9a1b7e2d4c8a9b0f1e2d3c4b5a6f"
              className={inputStyle}
            />
            <button
              onClick={() => void link()}
              disabled={linkBusy || !idInput.trim()}
              className="shrink-0 px-3 py-1.5 text-sm rounded-md bg-accent-500 text-white hover:bg-bolt-elements-button-primary-backgroundHover disabled:opacity-50"
            >
              {linkBusy ? 'Linking…' : 'Link'}
            </button>
          </div>
        </div>
      )}

      {linked && tiers.length > 0 && (
        <div className="space-y-2">
          <label htmlFor="unity-license-tier" className="block text-xs text-bolt-elements-textSecondary">
            Pro Tools tier
          </label>
          <select
            id="unity-license-tier"
            value={tier}
            onChange={(e) => setTier(e.target.value as LicenseTierOffer['tier'])}
            className={inputStyle}
          >
            {tiers.map((t) => (
              <option key={t.tier} value={t.tier}>
                {t.label} — {t.unlocked ? 'unlocked (free re-download)' : `${t.credits.toLocaleString()} credits`}
              </option>
            ))}
          </select>
          {selected && (
            <div className="text-xs text-bolt-elements-textSecondary">{tierExplanation(selected, email)}</div>
          )}
        </div>
      )}

      {linked && (
        <div className="flex gap-2">
          <button
            onClick={() => void generate()}
            disabled={genBusy || !selected}
            className="px-4 py-2 text-sm rounded-md bg-accent-500 text-white hover:bg-bolt-elements-button-primary-backgroundHover disabled:opacity-50"
          >
            {generateLabel}
          </button>
          <button
            onClick={() => license && downloadLicense(license)}
            disabled={!license}
            className="px-4 py-2 text-sm rounded-md border border-bolt-elements-borderColor text-bolt-elements-textSecondary hover:bg-bolt-elements-background-depth-3 disabled:opacity-50"
            title={license ? 'Save license.json to your computer' : 'Generate a license first'}
          >
            Download
          </button>
        </div>
      )}

      {/* Manual placement instructions — shown whenever the automatic drop did not land the file in Unity. */}
      {(drop?.status === 'skipped' || drop?.status === 'failed') && (
        <div className="text-xs rounded-md bg-bolt-elements-background-depth-2 px-3 py-2 space-y-1 text-bolt-elements-textSecondary">
          <div className="text-bolt-elements-textPrimary font-medium">Add the license to Unity manually</div>
          {drop.status === 'failed' && (
            <div className="text-bolt-elements-icon-error">Automatic drop failed: {drop.reason}</div>
          )}
          <div>
            Copy <code>/{WEB_LICENSE_PATH}</code> from this project into your Unity project at{' '}
            <code>{UNITY_LICENSE_PATH}</code> (or use <strong>Download</strong> and move the file yourself).
          </div>
        </div>
      )}
    </div>
  );
}
