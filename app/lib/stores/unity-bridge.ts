/**
 * The Unity Bridge client store (SPEC §4.17, D7, D16, D43, D55).
 *
 * Holds the project's bridge status (`GET /api/projects/:id/bridge`), whether the ONE Unity Bridge dialog
 * is open, the one pending consent request, the live job rows streamed by the current generation, and the
 * capture popup's picture (D55 — the Jobs panel is gone; a finished capture opens a small popup).
 *
 * ⚠️ THE REPLAY RULE (same as `active-skills.ts`): `useChat` re-presents its whole data array on every
 * stream chunk, so `updateBridgeFromPart` is idempotent — a consent part is keyed by its tool-call id
 * (and is never re-raised once answered), and a job's progress lines are deduped by count per scan.
 *
 * Every fetch is wrapped — a failure returns `{ok:false, message}` using the server's own `message`,
 * never a throw into a click handler.
 */
import { atom } from 'nanostores';
import { BRIDGE_MAX_IMAGE_BASE64, type BridgeHello, type BridgeJobStatus } from '~/lib/bridge/protocol';

/** Mirrors the JSON of `GET /api/projects/:projectId/bridge` (the route declares the same shape). */
export interface BridgeDeviceView {
  id: string;
  name: string;
  online: boolean;
  lastSeenAt?: string;
  hello?: BridgeHello;

  /** The per-computer Allow scripts switch (D58), off by default. */
  allowScripts: boolean;
}

export interface BridgeStatusView {
  enabled: boolean;
  state: 'unpaired' | 'offline' | 'online';

  /** The device the agent would drive: the most recently seen present one, else the last seen (D54). */
  device?: BridgeDeviceView;

  /**
   * The production App Builder origin (`APP_URL`), or null when the server has none. The install command
   * carries `--server <origin>` only when this page is NOT that origin — the helper defaults to production.
   */
  productionOrigin: string | null;
}

/** A capture the popup is showing (D55). */
export interface BridgeCapture {
  jobId: string;
  label: string;
  image: BridgeJobImage;
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

  /**
   * The latest picture a finished capture sent (a `unity_capture` result). Memory only — never
   * persisted, never re-fetched: it exists so the USER sees what the model was shown.
   */
  image?: BridgeJobImage;
}

export interface BridgeJobImage {
  base64: string;
  mimeType: 'image/png';
}

/** D55: there is ONE Unity Bridge dialog. */
export type BridgeDialog = 'bridge';

export const bridgeStatusStore = atom<BridgeStatusView | null>(null);
export const bridgeDialogStore = atom<BridgeDialog | null>(null);
export const bridgeCaptureStore = atom<BridgeCapture | null>(null);
export const bridgeConsentStore = atom<BridgeConsentRequest | null>(null);
export const bridgeLiveJobsStore = atom<Record<string, BridgeLiveJob>>({});

/** True while a status request is in flight (drives the icon's first-load spinner). */
export const bridgeStatusLoadingStore = atom<boolean>(false);

/*
 * Consent tool-call ids already raised (or answered). A replayed part for one of these never re-opens
 * the dialog — answering clears the store, and the next chunk re-presents the same part.
 */
const seenConsents = new Set<string>();

/** A capture that landed while a consent prompt was open — shown once the prompt closes. */
let deferredCapture: BridgeCapture | null = null;

function showCapture(capture: BridgeCapture): void {
  if (bridgeConsentStore.get() === null) {
    bridgeCaptureStore.set(capture);
  } else {
    deferredCapture = capture;
  }
}

/** The consent prompt just closed: a capture that waited behind it may now be shown. */
function releaseDeferredCapture(): void {
  if (deferredCapture && bridgeConsentStore.get() === null) {
    bridgeCaptureStore.set(deferredCapture);
    deferredCapture = null;
  }
}

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
    /* A failed status read keeps the last known status; the icon still opens the dialog. */
  } finally {
    bridgeStatusLoadingStore.set(false);
  }
}

export type InstallCodeResult = { ok: true; code: string; expiresAt: string } | { ok: false; message: string };

/**
 * Mint a single-use install code (D55) for the dialog's one command. A failure carries the server's own
 * sentence (e.g. the rate limit) so the dialog can show it verbatim.
 */
export async function mintInstallCode(): Promise<InstallCodeResult> {
  const result = await postJson('/api/bridge/devices', { action: 'invite' });

  if (!result.ok) {
    return { ok: false, message: result.message ?? 'Could not create an install code.' };
  }

  const data = (result.data ?? {}) as { code?: unknown; expiresAt?: unknown };

  if (typeof data.code !== 'string' || typeof data.expiresAt !== 'string') {
    return { ok: false, message: 'The server did not return an install code.' };
  }

  return { ok: true, code: data.code, expiresAt: data.expiresAt };
}

/**
 * Turn the device's Allow scripts switch on or off (D58). A failure carries the server's own sentence so
 * the dialog can show it and put the checkbox back.
 */
export async function setBridgeAllowScripts(deviceId: string, value: boolean): Promise<ActionResult> {
  const result = await postJson('/api/bridge/devices', { action: 'allowScripts', deviceId, value });

  if (!result.ok) {
    return { ok: false, message: result.message ?? 'Could not change Allow scripts.' };
  }

  return { ok: true };
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
    if (typeof p.toolCallId !== 'string') {
      return;
    }

    /*
     * The server ended the wait (answered, timed out, or the turn stopped): close the prompt for THAT
     * call, and latch it so a replayed request part never re-opens it.
     */
    if (p.closed === true) {
      seenConsents.add(p.toolCallId);

      if (bridgeConsentStore.get()?.toolCallId === p.toolCallId) {
        bridgeConsentStore.set(null);
        releaseDeferredCapture();
      }

      return;
    }

    if (typeof p.generationId !== 'string' || seenConsents.has(p.toolCallId)) {
      return;
    }

    seenConsents.add(p.toolCallId);

    // A capture popup on screen steps aside for the prompt (it takes the clicks) and returns after it.
    const onScreen = bridgeCaptureStore.get();

    if (onScreen) {
      deferredCapture = onScreen;
      bridgeCaptureStore.set(null);
    }

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
  const incomingImage = readImage(p.image);
  const newImage = incomingImage !== undefined && incomingImage.base64 !== current?.image?.base64;
  const nextImage = incomingImage ?? current?.image;

  if (
    current &&
    !appendLine &&
    !newImage &&
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
      ...(nextImage ? { image: nextImage } : {}),
    },
  });

  /*
   * A capture just landed: show it in the capture popup (D55). Only on the transition (a replay carries
   * the same bytes and returned above), and never over a pending consent prompt — a second modal on top of
   * it would take its clicks; the capture waits and opens when the prompt closes.
   */
  if (newImage && incomingImage) {
    showCapture({ jobId, label: nextLabel, image: incomingImage });
  }
}

/** A capture image from a data part, or undefined — a PNG within the same cap the server applies. */
function readImage(value: unknown): BridgeJobImage | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const { base64, mimeType } = value as { base64?: unknown; mimeType?: unknown };

  if (
    mimeType !== 'image/png' ||
    typeof base64 !== 'string' ||
    base64.length === 0 ||
    base64.length > BRIDGE_MAX_IMAGE_BASE64
  ) {
    return undefined;
  }

  return { base64, mimeType };
}

/** Close any pending consent prompt (the turn ended — nothing is waiting for the answer any more). */
export function clearBridgeConsent(): void {
  const consent = bridgeConsentStore.get();

  if (consent) {
    seenConsents.add(consent.toolCallId);
    bridgeConsentStore.set(null);
  }

  releaseDeferredCapture();
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
  releaseDeferredCapture();

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
  deferredCapture = null;
  bridgeStatusStore.set(null);
  bridgeDialogStore.set(null);
  bridgeCaptureStore.set(null);
  bridgeConsentStore.set(null);
  bridgeLiveJobsStore.set({});
  bridgeStatusLoadingStore.set(false);
}
