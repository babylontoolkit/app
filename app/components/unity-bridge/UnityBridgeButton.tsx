/**
 * The Unity icon in the chat composer (SPEC §4.17, D7, D43, D55).
 *
 * Renders for every open project — including when the bridge is disabled — and a click opens the ONE
 * Unity Bridge dialog (D55), whatever the state: the dialog itself decides between the install command,
 * the running status, and "turned off on this server". Green when the helper is online, titled
 * `Unity Bridge: <computer>` (+ ` · <current Unity project>`); `Connect Unity` otherwise. There is no
 * project link (D54) — the agent drives the most recently seen paired device.
 *
 * Also mounts the two popups that stay: the consent prompt and the capture popup.
 *
 * There is no header toolbar button — this icon is the only entry point.
 */
import { useEffect, useRef } from 'react';
import { useStore } from '@nanostores/react';
import { IconButton } from '~/components/ui/IconButton';
import { projectId as projectIdStore } from '~/lib/persistence';
import { streamingState } from '~/lib/stores/streaming';
import {
  bridgeCaptureStore,
  bridgeConsentStore,
  bridgeDialogStore,
  bridgeStatusLoadingStore,
  bridgeStatusStore,
  clearBridgeConsent,
  refreshBridgeStatus,
  type BridgeStatusView,
} from '~/lib/stores/unity-bridge';
import { classNames } from '~/utils/classNames';
import { UnityBridgeConsentDialog } from './UnityBridgeConsentDialog';
import { UnityBridgeDialog } from './UnityBridgeDialog';
import { UnityCapturePopup } from './UnityCapturePopup';

const STATUS_POLL_MS = 20_000;

export function bridgeIconTitle(status: BridgeStatusView | null): string {
  if (!status || !status.enabled || status.state !== 'online') {
    return 'Connect Unity';
  }

  const deviceName = status.device?.name ?? 'your computer';
  const current = status.device?.hello?.currentProject;

  return `Unity Bridge: ${deviceName}${current ? ` · ${current}` : ''}`;
}

export function UnityBridgeButton() {
  const projectId = useStore(projectIdStore);
  const status = useStore(bridgeStatusStore);
  const loading = useStore(bridgeStatusLoadingStore);
  const streaming = useStore(streamingState);
  const wasStreaming = useRef(streaming);

  // A consent prompt, a capture or an open dialog never survives a project switch.
  useEffect(() => {
    bridgeConsentStore.set(null);
    bridgeDialogStore.set(null);
    bridgeCaptureStore.set(null);
    bridgeStatusStore.set(null);
  }, [projectId]);

  useEffect(() => {
    if (!projectId) {
      return undefined;
    }

    void refreshBridgeStatus(projectId);

    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') {
        void refreshBridgeStatus(projectId);
      }
    }, STATUS_POLL_MS);

    return () => clearInterval(timer);
  }, [projectId]);

  // Nothing is waiting for a consent answer once the turn has ended — the prompt would ask about nothing.
  useEffect(() => {
    const ended = wasStreaming.current && !streaming;
    wasStreaming.current = streaming;

    if (ended) {
      clearBridgeConsent();
    }
  }, [streaming]);

  if (!projectId) {
    return null;
  }

  const enabled = status?.enabled ?? false;
  const online = enabled && status?.state === 'online';
  const showSpinner = status === null && loading;

  const open = () => {
    if (projectId) {
      void refreshBridgeStatus(projectId);
    }

    bridgeDialogStore.set('bridge');
  };

  /*
   * The online colour sits on the ICON, not the button: IconButton's base
   * `text-bolt-elements-item-contentDefault` is emitted after the success utility in the generated
   * stylesheet, so a colour class on the button loses (rule order, not class-string order). The icon's own
   * colour cannot be overridden by the button's.
   */
  const iconClass = classNames('i-ph:cube-duotone text-xl', online ? 'text-bolt-elements-icon-success' : '');

  return (
    <>
      <IconButton title={bridgeIconTitle(status)} className="transition-all" onClick={open}>
        {showSpinner ? (
          <div className="i-svg-spinners:90-ring-with-bg text-bolt-elements-loader-progress text-xl animate-spin" />
        ) : (
          <div data-testid="unity-bridge-icon" className={iconClass} />
        )}
      </IconButton>

      <UnityBridgeDialog projectId={projectId} />
      <UnityCapturePopup />
      <UnityBridgeConsentDialog />
    </>
  );
}
