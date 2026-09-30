/**
 * The Unity icon in the chat composer (SPEC §4.17, D7, D43, D52).
 *
 * Renders for every open project — including when the bridge is disabled, when it is then titled
 * "Unity scenes" and opens the Connect dialog showing only the Local scenes section (local scenes never
 * wait on the bridge, D52). A click opens the Status panel only when the project is linked and the
 * bridge is enabled; every other state (including a status that has not loaded, or a 404) opens the
 * Connect dialog, so the Local scenes section is never behind a slow or failed status request.
 *
 * There is no header toolbar button — this icon is the only entry point.
 */
import { useEffect, useRef } from 'react';
import { useStore } from '@nanostores/react';
import { IconButton } from '~/components/ui/IconButton';
import { projectId as projectIdStore } from '~/lib/persistence';
import { streamingState } from '~/lib/stores/streaming';
import {
  bridgeConsentStore,
  bridgeDialogStore,
  bridgeLiveJobsStore,
  bridgeStatusLoadingStore,
  bridgeStatusStore,
  refreshBridgeStatus,
  type BridgeStatusView,
} from '~/lib/stores/unity-bridge';
import { classNames } from '~/utils/classNames';
import { UnityBridgeConnectDialog } from './UnityBridgeConnectDialog';
import { UnityBridgeConsentDialog } from './UnityBridgeConsentDialog';
import { UnityBridgeJobsPanel } from './UnityBridgeJobsPanel';
import { UnityBridgeStatusPanel } from './UnityBridgeStatusPanel';

const STATUS_POLL_MS = 20_000;

/** Generations whose Jobs panel has already auto-opened (once per generation). */
const autoOpenedGenerations = new Set<string>();

/** Test seam. */
export function resetUnityBridgeButtonForTests(): void {
  autoOpenedGenerations.clear();
}

function titleFor(status: BridgeStatusView | null): string {
  if (!status || !status.enabled) {
    return status && !status.enabled ? 'Unity scenes' : 'Connect Unity';
  }

  const deviceName = status.link?.deviceName ?? 'your computer';

  switch (status.state) {
    case 'online':
      return `Unity Bridge: ${deviceName} · ${status.link?.unityProjectName ?? ''}${
        status.link?.allowScripts ? ' · scripts allowed' : ''
      }`;
    case 'offline':
      return `Unity Bridge offline — run the helper on ${deviceName}`;
    default:
      return 'Connect Unity';
  }
}

export function UnityBridgeButton() {
  const projectId = useStore(projectIdStore);
  const status = useStore(bridgeStatusStore);
  const loading = useStore(bridgeStatusLoadingStore);
  const liveJobs = useStore(bridgeLiveJobsStore);
  const streaming = useStore(streamingState);
  const wasStreaming = useRef(streaming);

  // A consent prompt or an open dialog never survives a project switch.
  useEffect(() => {
    bridgeConsentStore.set(null);
    bridgeDialogStore.set(null);
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

  /*
   * Auto-open the Jobs panel once per generation: when the turn stops streaming and a job it started
   * is still queued or running, the user should see it progress rather than wonder where it went.
   */
  useEffect(() => {
    const ended = wasStreaming.current && !streaming;
    wasStreaming.current = streaming;

    if (!ended) {
      return;
    }

    for (const job of Object.values(liveJobs)) {
      if ((job.status === 'queued' || job.status === 'running') && !autoOpenedGenerations.has(job.generationId)) {
        autoOpenedGenerations.add(job.generationId);
        bridgeDialogStore.set('jobs');

        return;
      }
    }
  }, [streaming, liveJobs]);

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

    bridgeDialogStore.set(
      enabled && (status?.state === 'online' || status?.state === 'offline') ? 'status' : 'connect',
    );
  };

  return (
    <>
      <IconButton
        title={titleFor(status)}
        className={classNames('transition-all', online ? 'text-bolt-elements-icon-success' : '')}
        onClick={open}
      >
        {showSpinner ? (
          <div className="i-svg-spinners:90-ring-with-bg text-bolt-elements-loader-progress text-xl animate-spin" />
        ) : (
          <div className="i-ph:cube-duotone text-xl" />
        )}
      </IconButton>

      <UnityBridgeConnectDialog projectId={projectId} />
      <UnityBridgeStatusPanel projectId={projectId} />
      <UnityBridgeJobsPanel projectId={projectId} />
      <UnityBridgeConsentDialog />
    </>
  );
}
