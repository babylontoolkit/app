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
import { useEffect, useState } from 'react';
import { useStore } from '@nanostores/react';
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

const COMPANION_COMMAND = 'npx @babylonjs-toolkit/bridge';
const DEFAULT_PORT = '8080';

export function UnityConnection() {
  const connection = useStore(unityConnectionAtom);
  const tools = useStore(unityToolsAtom);

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
        <Dialog className="max-w-[520px] p-6">
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
        </Dialog>
      </DialogRoot>
    </>
  );
}
