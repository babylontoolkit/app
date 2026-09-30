/**
 * The Unity Bridge client store (SPEC §4.17, D7, D16, D43).
 *
 * Holds the project's bridge status (`GET /api/projects/:id/bridge`), which of the three bridge dialogs
 * is open, the one pending consent request, and the live job rows streamed by the current generation.
 *
 * ⚠️ THE REPLAY RULE (same as `active-skills.ts`): `useChat` re-presents its whole data array on every
 * stream chunk, so `updateBridgeFromPart` is idempotent — a consent part is keyed by its tool-call id
 * (and is never re-raised once answered), and a job's progress lines are deduped by count per scan.
 *
 * The per-project local-scene origin is NOT here: it lives in `~/lib/local-scenes/origin.ts` (D52), so
 * the local-scene UI imports nothing from the bridge.
 *
 * Every fetch is wrapped — a failure returns `{ok:false, message}` using the server's own `message`,
 * never a throw into a click handler.
 */
import { atom } from 'nanostores';
import type { BridgeHello, BridgeJobStatus } from '~/lib/bridge/protocol';

/** Mirrors the JSON of `GET /api/projects/:projectId/bridge` (the route declares the same shape). */
export interface BridgeStatusView {
  enabled: boolean;
  state: 'unpaired' | 'unlinked' | 'offline' | 'online';
  link: { deviceId: string; deviceName: string; unityProjectName: string; allowScripts: boolean } | null;
  devices: Array<{ id: string; name: string; os: string; online: boolean; lastSeenAt?: string; hello?: BridgeHello }>;
  jobs: Array<{
    id: string;
    operation: string;
    status: BridgeJobStatus;
    createdAt: string;
    finishedAt?: string;
    resultText?: string;
    error?: string;
  }>;
}

export interface BridgeConsentRequest {
  generationId: string;
  toolCallId: string;
  operation: string;
  target: string;
}

export interface BridgeLiveJob {
  generationId: string;
  status: BridgeJobStatus;
  label: string;
  lines: string[];
}

export type BridgeDialog = 'connect' | 'status' | 'jobs';

export const bridgeStatusStore = atom<BridgeStatusView | null>(null);
export const bridgeDialogStore = atom<BridgeDialog | null>(null);
export const bridgeConsentStore = atom<BridgeConsentRequest | null>(null);
export const bridgeLiveJobsStore = atom<Record<string, BridgeLiveJob>>({});

/** True while a status request is in flight (drives the icon's first-load spinner). */
export const bridgeStatusLoadingStore = atom<boolean>(false);

/*
 * Consent tool-call ids already raised (or answered). A replayed part for one of these never re-opens
 * the dialog — answering clears the store, and the next chunk re-presents the same part.
 */
const seenConsents = new Set<string>();

type ActionResult = { ok: boolean; message?: string };

const describeError = (error: unknown) => (error instanceof Error ? error.message : String(error));

async function readMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { message?: unknown };

    if (typeof body?.message === 'string' && body.message) {
      return body.message;
    }
  } catch {
    /* not JSON */
  }

  return `The server answered ${response.status}.`;
}

async function postJson(url: string, body: Record<string, unknown>): Promise<ActionResult & { data?: unknown }> {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      return { ok: false, message: await readMessage(response) };
    }

    let data: unknown;

    try {
      data = await response.json();
    } catch {
      data = undefined;
    }

    return { ok: true, data };
  } catch (error) {
    return { ok: false, message: describeError(error) };
  }
}

/** GET the project's bridge status. A 404 means the project is not the caller's → the store becomes `null`. */
export async function refreshBridgeStatus(projectId: string): Promise<void> {
  bridgeStatusLoadingStore.set(true);

  try {
    const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/bridge`, { cache: 'no-store' });

    if (response.status === 404) {
      bridgeStatusStore.set(null);
      return;
    }

    if (!response.ok) {
      return;
    }

    bridgeStatusStore.set((await response.json()) as BridgeStatusView);
  } catch {
    /* A failed status read keeps the last known status; the icon still opens the Connect dialog. */
  } finally {
    bridgeStatusLoadingStore.set(false);
  }
}

export async function bridgeProjectAction(projectId: string, body: Record<string, unknown>): Promise<ActionResult> {
  const { ok, message } = await postJson(`/api/projects/${encodeURIComponent(projectId)}/bridge`, body);
  return ok ? { ok } : { ok, message };
}

/** Approve a helper's pairing code. On success `message` carries the paired device's name. */
export async function approvePairingCode(code: string): Promise<ActionResult> {
  const result = await postJson('/api/bridge/devices', { action: 'approve', code });

  if (!result.ok) {
    return { ok: false, message: result.message };
  }

  const deviceName = (result.data as { deviceName?: unknown } | undefined)?.deviceName;

  return { ok: true, message: typeof deviceName === 'string' ? deviceName : undefined };
}

export async function revokeDevice(deviceId: string): Promise<ActionResult> {
  const { ok, message } = await postJson('/api/bridge/devices', { action: 'revoke', deviceId });
  return ok ? { ok } : { ok, message };
}

/**
 * Ingest one chat data part if it is a `bridge-consent` or `bridge-job`. Safe to call with every part
 * on every re-scan; anything else is ignored.
 */
export function updateBridgeFromPart(part: unknown): void {
  if (!part || typeof part !== 'object') {
    return;
  }

  const p = part as Record<string, unknown>;

  if (p.type === 'bridge-consent') {
    if (typeof p.toolCallId !== 'string' || typeof p.generationId !== 'string' || seenConsents.has(p.toolCallId)) {
      return;
    }

    seenConsents.add(p.toolCallId);
    bridgeConsentStore.set({
      generationId: p.generationId,
      toolCallId: p.toolCallId,
      operation: typeof p.operation === 'string' ? p.operation : '',
      target: typeof p.target === 'string' ? p.target : '',
    });

    return;
  }

  if (p.type !== 'bridge-job' || typeof p.jobId !== 'string' || typeof p.generationId !== 'string') {
    return;
  }

  const jobId = p.jobId;
  const status = isJobStatus(p.status) ? p.status : undefined;
  const line = typeof p.line === 'string' ? p.line : undefined;
  const jobs = bridgeLiveJobsStore.get();
  const current = jobs[jobId];

  /*
   * Lines are deduped BY COUNT: the n-th progress line of a job within one scan of the data array is
   * the same line on every replay, so it is appended only when n reaches past what the row holds.
   * (`beginBridgeScan` marks the start of each scan.)
   */
  let appendLine = false;

  if (line !== undefined) {
    const index = scanLineCounts.get(jobId) ?? 0;
    scanLineCounts.set(jobId, index + 1);
    appendLine = index >= (current?.lines.length ?? 0);
  }

  // A status only moves forward, so a replayed `queued` never un-finishes a job.
  const nextStatus =
    status && (!current || STATUS_RANK[status] >= STATUS_RANK[current.status]) ? status : (current?.status ?? 'queued');
  const nextLabel = (typeof p.label === 'string' && p.label) || current?.label || '';

  if (
    current &&
    !appendLine &&
    current.status === nextStatus &&
    current.label === nextLabel &&
    current.generationId === p.generationId
  ) {
    return; // a replay — nothing new
  }

  bridgeLiveJobsStore.set({
    ...jobs,
    [jobId]: {
      generationId: p.generationId,
      status: nextStatus,
      label: nextLabel,
      lines: appendLine && line !== undefined ? [...(current?.lines ?? []), line] : (current?.lines ?? []),
    },
  });
}

const STATUS_RANK: Record<BridgeJobStatus, number> = {
  queued: 0,
  running: 1,
  succeeded: 2,
  failed: 2,
  refused: 2,
  cancelled: 2,
};

function isJobStatus(value: unknown): value is BridgeJobStatus {
  return typeof value === 'string' && value in STATUS_RANK;
}

/** Progress lines seen per job in the CURRENT scan of the chat data array. */
const scanLineCounts = new Map<string, number>();

/** Call once before each re-scan of the chat data array (the line dedupe counts per scan). */
export function beginBridgeScan(): void {
  scanLineCounts.clear();
}

/** Answer the pending consent request. Posts `consent:<toolCallId>` and clears the store either way. */
export async function answerConsent(approved: boolean): Promise<void> {
  const consent = bridgeConsentStore.get();

  if (!consent) {
    return;
  }

  bridgeConsentStore.set(null);

  await postJson('/api/agent/tool-result', {
    generationId: consent.generationId,
    toolCallId: `consent:${consent.toolCallId}`,
    result: { approved },
  });
}

/** Test seam: forget every replay latch and reset all stores. */
export function resetUnityBridgeStoresForTests(): void {
  seenConsents.clear();
  scanLineCounts.clear();
  bridgeStatusStore.set(null);
  bridgeDialogStore.set(null);
  bridgeConsentStore.set(null);
  bridgeLiveJobsStore.set({});
  bridgeStatusLoadingStore.set(false);
}
