/**
 * Unity Bridge service (SPEC §4.17) — the operation pipeline a bridge tool call runs:
 * validate → tier → (consent) → dispatch → wait for `started` → wait for the result.
 *
 * 🔴 Bridge operations are NOT billed separately (D53, owner 2026-09-29): the model turn that drives
 * Unity/Blender is billed like any generation (its tokens, including the extra tool rounds), and running
 * a command on the user's machine costs nothing extra. This module writes NO ledger row, ever — pinned by
 * `service.spec.ts`. Do not re-add a quote/debit/refund here.
 *
 * Rules, each failing silently when wrong:
 *   - consent comes FIRST: a consent-tier call is never dispatched before the user said yes (D16);
 *   - a job that never started is settled by ONE function, `markNotStarted`, which never touches a
 *     terminal row or a started one (the latch);
 *   - every row write goes through one rule: never overwrite a terminal row;
 *   - nothing on a tool path throws: every outcome is a sentence for the model;
 *   - the server does NOT gate scripts (D55): every dispatch says `allowScripts: true`, and the helper's
 *     own `--no-scripts` is the only switch — the user's computer decides, and the helper refuses there.
 *
 * All writes for one job are serialised through an in-process chain (`withJobLock`). The relay lives on
 * ONE server instance (D5), so this makes the latch a real guarantee there rather than a read-then-write
 * check two settlers (a cancel and a pickup timeout) could both pass.
 */
import { createScopedLogger } from '~/utils/logger';
import {
  BRIDGE_CONSENT_TIMEOUT_MS,
  BRIDGE_JOB_WAIT_MAX_S,
  BRIDGE_MAX_IMAGE_BASE64,
  BRIDGE_PICKUP_TIMEOUT_MS,
  BRIDGE_SYNC_WAIT_MS,
  capText,
  type BridgeHello,
  type BridgeJobEvent,
  type BridgeJobStatus,
  type BridgeOperation,
  type BridgeResultPayload,
} from '~/lib/bridge/protocol';
import { classifyOperation } from '~/lib/bridge/tiers';
import { validateOperation } from '~/lib/bridge/validate';
import { awaitClientToolResult } from '~/lib/.server/agent/mcp-relay';
import { isBridgeEnabled, mintId } from './auth';
import { cancelBridgeJob, deviceHello, deviceLastSeen, enqueueBridgeJob, getJobHandle, isDevicePresent } from './relay';
import { getBridgeStore, type BridgeDeviceRow, type BridgeJobRow } from './store';

const logger = createScopedLogger('bridge.service');

export interface BridgeRunContext {
  userId: string;
  projectId: string;
  generationId: string;
  toolCallId: string;

  /** The paired device this turn dispatches to (D54: the user's most recently seen present device). */
  deviceId: string;
  deviceName: string;
  abortSignal?: AbortSignal;
  context: unknown;
  emit: (event: BridgeUiEvent) => void;
}

export type BridgeUiEvent =
  | { type: 'bridge-consent'; toolCallId: string; operation: string; tier: 'consent'; target: string }

  /** The consent wait ended — answered, timed out, or the turn stopped. The client closes the prompt. */
  | { type: 'bridge-consent'; toolCallId: string; closed: true }
  | {
      type: 'bridge-job';
      jobId: string;
      status: BridgeJobStatus;
      label: string;
      line?: string;

      /** A finished capture's picture, so the USER sees it too (the capture popup) — never over the cap. */
      image?: { base64: string; mimeType: 'image/png' };
    };

export type BridgeToolOutcome = string | { text: string; image: { base64: string; mimeType: 'image/png' } };

const TERMINAL: ReadonlySet<BridgeJobStatus> = new Set(['succeeded', 'failed', 'refused', 'cancelled']);

const isTerminal = (row: BridgeJobRow) => TERMINAL.has(row.status);

/**
 * The capture a final result may be shown to the user with: a PNG within `BRIDGE_MAX_IMAGE_BASE64`, else
 * nothing. The result route already drops a larger one; this is the backstop on the way to the browser
 * (the data part rides every stream chunk the rest of the turn).
 */
export function displayableImage(
  image: BridgeResultPayload['image'] | undefined,
): { base64: string; mimeType: 'image/png' } | undefined {
  if (
    !image ||
    image.mimeType !== 'image/png' ||
    typeof image.base64 !== 'string' ||
    image.base64.length === 0 ||
    image.base64.length > BRIDGE_MAX_IMAGE_BASE64
  ) {
    return undefined;
  }

  return { base64: image.base64, mimeType: 'image/png' };
}

/** Appended to a capture's tool-result text, so the model never refers to "the capture above". */
export const CAPTURE_SHOWN_NOTE = '(The user sees this capture in a popup, not in the chat.)';

/*
 * ---------------------------------------------------------------------------------------------
 * Per-job serialisation
 * ---------------------------------------------------------------------------------------------
 */

const jobChains = new Map<string, Promise<unknown>>();

/**
 * Run `fn` after every earlier write for this job. The chain is registered SYNCHRONOUSLY, so a caller
 * that enqueues before its first `await` is ordered before anything enqueued later.
 */
function withJobLock<T>(jobId: string, fn: () => Promise<T>): Promise<T> {
  const previous = jobChains.get(jobId) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  const tail = run.catch(() => undefined);

  jobChains.set(jobId, tail);
  void tail.then(() => {
    if (jobChains.get(jobId) === tail) {
      jobChains.delete(jobId);
    }
  });

  return run;
}

function safeEmit(emit: (event: BridgeUiEvent) => void, event: BridgeUiEvent): void {
  try {
    emit(event);
  } catch (error) {
    logger.warn(`bridge UI event dropped: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/*
 * ---------------------------------------------------------------------------------------------
 * The ONE not-started writer
 * ---------------------------------------------------------------------------------------------
 */

/** Caller holds the job lock. Returns true when this call settled the job. */
async function markNotStartedLocked(
  jobId: string,
  status: 'cancelled' | 'refused',
  reason: string,
  context: unknown,
): Promise<boolean> {
  const store = getBridgeStore(context);
  const row = await store.getJob(jobId);

  if (!row) {
    logger.warn(`markNotStarted: no row for bridge job ${jobId}`);
    return false;
  }

  // The latch: a terminal row is already settled; a started job is the helper's to finish.
  if (isTerminal(row) || row.started) {
    return false;
  }

  await store.putJob({ ...row, status, error: reason, finishedAt: new Date().toISOString() });

  return true;
}

/** THE not-started writer. Terminal row or started → no-op. Status only — no ledger row (D53). */
export async function markNotStarted(
  jobId: string,
  status: 'cancelled' | 'refused',
  reason: string,
  context: unknown,
): Promise<void> {
  await withJobLock(jobId, () => markNotStartedLocked(jobId, status, reason, context));
}

/** markNotStarted(id, 'cancelled', 'cancelled before it started', context) for each id; never throws. */
export async function settleDropped(jobIds: string[], context: unknown): Promise<void> {
  for (const jobId of jobIds) {
    try {
      await markNotStarted(jobId, 'cancelled', 'cancelled before it started', context);
    } catch (error) {
      logger.error(`settleDropped failed for ${jobId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/*
 * ---------------------------------------------------------------------------------------------
 * Helper events → the job row
 * ---------------------------------------------------------------------------------------------
 */

function makeOnEvent(input: {
  jobId: string;
  label: string;
  context: unknown;
  emit: (event: BridgeUiEvent) => void;
}): (event: BridgeJobEvent) => Promise<void> {
  const { jobId, label, context, emit } = input;
  const store = () => getBridgeStore(context);
  const job = (status: BridgeJobStatus, line?: string): Extract<BridgeUiEvent, { type: 'bridge-job' }> => ({
    type: 'bridge-job',
    jobId,
    status,
    label,
    ...(line === undefined ? {} : { line }),
  });

  return (event) =>
    withJobLock(jobId, async () => {
      try {
        switch (event.type) {
          case 'started': {
            const row = await store().getJob(jobId);

            if (!row || isTerminal(row)) {
              return;
            }

            // Idempotent: a duplicate `started` writes nothing and never regresses the row.
            if (!row.started || row.status !== 'running') {
              await store().putJob({ ...row, status: 'running', started: true });
            }

            safeEmit(emit, job('running'));

            return;
          }

          case 'progress': {
            safeEmit(emit, job('running', event.line));
            return;
          }

          case 'final': {
            const row = await store().getJob(jobId);

            if (!row || isTerminal(row)) {
              return;
            }

            const status: BridgeJobStatus = event.result.ok ? 'succeeded' : 'failed';

            await store().putJob({
              ...row,
              status,
              started: true,
              resultText: capText(event.result.text ?? ''),
              finishedAt: new Date().toISOString(),
            });

            const image = event.result.ok ? displayableImage(event.result.image) : undefined;
            safeEmit(emit, image ? { ...job(status), image } : job(status));

            return;
          }

          case 'refused': {
            const row = await store().getJob(jobId);

            if (!row || isTerminal(row)) {
              return;
            }

            if (row.started) {
              // Refused after it began: record the failure.
              await store().putJob({
                ...row,
                status: 'failed',
                error: event.reason,
                finishedAt: new Date().toISOString(),
              });
              safeEmit(emit, job('failed'));

              return;
            }

            await markNotStartedLocked(jobId, 'refused', event.reason, context);
            safeEmit(emit, job('refused'));

            return;
          }

          default:
            return;
        }
      } catch (error) {
        logger.error(`bridge job ${jobId} event ${event.type} failed: ${(error as Error).message}`);
      }
    });
}

/*
 * ---------------------------------------------------------------------------------------------
 * Formatting
 * ---------------------------------------------------------------------------------------------
 */

function formatFinal(final: BridgeResultPayload): BridgeToolOutcome {
  const header = final.ok ? '' : 'The operation ran but reported a failure:\n';
  const text = header + (final.text ?? '');

  if (!final.image) {
    return text;
  }

  // Only a picture the capture popup actually received is claimed as shown to the user.
  const shown = final.ok && displayableImage(final.image) !== undefined;

  return { text: shown ? `${text}\n${CAPTURE_SHOWN_NOTE}` : text, image: final.image };
}

function formatRow(row: BridgeJobRow): string {
  const detail = row.status === 'succeeded' || row.status === 'failed' ? row.resultText : row.error;
  return `Job ${row.id} (${row.operation}): ${row.status}.${detail ? `\n${detail}` : ''}`;
}

const notFound = (jobId: string) => `No Unity Bridge job "${jobId}" was found.`;

async function ownedRow(jobId: string, userId: string, context: unknown): Promise<BridgeJobRow | null> {
  const row = await getBridgeStore(context).getJob(jobId);

  return row && row.userId === userId ? row : null;
}

/** After a lock drains: read the settled row (a refusal's reason is written by `onEvent`). */
const settledRow = (jobId: string, context: unknown) => withJobLock(jobId, () => getBridgeStore(context).getJob(jobId));

/*
 * ---------------------------------------------------------------------------------------------
 * The pipeline
 * ---------------------------------------------------------------------------------------------
 */

export async function runBridgeOperation(
  op: BridgeOperation,
  label: string,
  ctx: BridgeRunContext,
): Promise<BridgeToolOutcome> {
  try {
    const invalid = validateOperation(op);

    if (invalid) {
      return `The Unity Bridge refused this: ${invalid}`;
    }

    const { tier, reason } = classifyOperation(op);

    if (tier === 'refused') {
      return `The Unity Bridge does not run this: ${reason}`;
    }

    // D16: consent BEFORE dispatch.
    if (tier === 'consent') {
      safeEmit(ctx.emit, {
        type: 'bridge-consent',
        toolCallId: ctx.toolCallId,
        operation: label,
        tier: 'consent',
        target: deviceHello(ctx.deviceId)?.currentProject ?? ctx.deviceName,
      });

      let answer: Awaited<ReturnType<typeof awaitClientToolResult>>;

      try {
        answer = await awaitClientToolResult({
          generationId: ctx.generationId,
          toolCallId: 'consent:' + ctx.toolCallId,
          userId: ctx.userId,
          abortSignal: ctx.abortSignal,
          timeoutMs: BRIDGE_CONSENT_TIMEOUT_MS,
        });
      } finally {
        // However the wait ended, the prompt must not stay on the user's screen asking about nothing.
        safeEmit(ctx.emit, { type: 'bridge-consent', toolCallId: ctx.toolCallId, closed: true });
      }

      /*
       * An unanswered prompt (timeout, Stop, the turn ending) is NOT a refusal: the relay settles it with
       * an `error` and no `result`. Telling the model "the user did not allow this" would be false — the
       * user never saw it long enough to decide.
       */
      if (answer.result === undefined) {
        return `The user did not answer the consent prompt in time (${label}); nothing ran. Ask them again if it's still needed.`;
      }

      if ((answer.result as { approved?: unknown } | null)?.approved !== true) {
        return `The user did not allow this operation (${label}). Nothing ran.`;
      }
    }

    const jobId = mintId('brg');
    const store = getBridgeStore(ctx.context);

    await store.putJob({
      id: jobId,
      userId: ctx.userId,
      projectId: ctx.projectId,
      deviceId: ctx.deviceId,
      operation: label,
      tier,
      status: 'queued',
      started: false,
      createdAt: new Date().toISOString(),
    });
    safeEmit(ctx.emit, { type: 'bridge-job', jobId, status: 'queued', label });

    const handle = enqueueBridgeJob({
      deviceId: ctx.deviceId,
      userId: ctx.userId,
      generationId: ctx.generationId,
      dispatch: {
        jobId,
        op,
        allowScripts: true, // D55 — the helper's --no-scripts is the only switch
        consentGranted: tier === 'consent',
      },
      onEvent: makeOnEvent({ jobId, label, context: ctx.context, emit: ctx.emit }),
    });

    const started = await handle.waitStarted(BRIDGE_PICKUP_TIMEOUT_MS, ctx.abortSignal);

    if (!started) {
      const cancelled = cancelBridgeJob(jobId, ctx.userId);

      // It started in the gap between the timer and this line: wait for the result.
      if (cancelled !== 'signalled') {
        await markNotStarted(jobId, 'cancelled', 'not picked up', ctx.context);
        safeEmit(ctx.emit, { type: 'bridge-job', jobId, status: 'cancelled', label });

        return 'The Unity Bridge helper did not pick up the job within 30 s. Nothing ran. Ask the user to check the helper is running.';
      }
    }

    const final = await handle.waitFinal(BRIDGE_SYNC_WAIT_MS, ctx.abortSignal);

    if (final === 'refused') {
      const row = await settledRow(jobId, ctx.context);

      return `The Unity Bridge helper refused to run this: ${row?.error ?? 'no reason given'}. Nothing ran.`;
    }

    if (final === null) {
      return `Still running on the user's machine as job ${jobId}. Call bridge_job with action "wait" and jobId "${jobId}" to wait for it (up to 90 s per call).`;
    }

    return formatFinal(final);
  } catch (error) {
    logger.error(`bridge operation ${label} failed: ${error instanceof Error ? error.message : String(error)}`);

    return `The Unity Bridge could not run this operation (${label}): ${error instanceof Error ? error.message : String(error)}`;
  }
}

export async function jobControl(
  action: 'status' | 'wait' | 'cancel',
  jobId: string,
  maxSeconds: number,
  ctx: Pick<BridgeRunContext, 'userId' | 'context' | 'abortSignal'>,
): Promise<BridgeToolOutcome> {
  try {
    switch (action) {
      case 'status': {
        const row = await ownedRow(jobId, ctx.userId, ctx.context);
        return row ? formatRow(row) : notFound(jobId);
      }

      case 'wait': {
        const handle = getJobHandle(jobId, ctx.userId);

        if (!handle) {
          const row = await ownedRow(jobId, ctx.userId, ctx.context);
          return row ? formatRow(row) : notFound(jobId);
        }

        const seconds = Number.isFinite(maxSeconds) && maxSeconds > 0 ? maxSeconds : BRIDGE_JOB_WAIT_MAX_S;
        const final = await handle.waitFinal(Math.min(seconds, BRIDGE_JOB_WAIT_MAX_S) * 1000, ctx.abortSignal);

        if (final === 'refused') {
          const row = await settledRow(jobId, ctx.context);
          return row ? formatRow(row) : notFound(jobId);
        }

        if (final === null) {
          // A job cancelled while we waited resolves null too — report the settled row, not "running".
          const row = await ownedRow(jobId, ctx.userId, ctx.context);

          if (row && isTerminal(row)) {
            return formatRow(row);
          }

          return `Job ${jobId} is still running. Call bridge_job wait again.`;
        }

        return formatFinal(final);
      }

      case 'cancel': {
        const outcome = cancelBridgeJob(jobId, ctx.userId);

        if (outcome === 'dropped') {
          await markNotStarted(jobId, 'cancelled', 'cancelled by the agent', ctx.context);
          return `Job ${jobId} was cancelled before it started. Nothing ran.`;
        }

        if (outcome === 'signalled') {
          return `Job ${jobId} had already started on the user's machine; a cancel was sent to the helper.`;
        }

        const row = await ownedRow(jobId, ctx.userId, ctx.context);

        if (!row) {
          return notFound(jobId);
        }

        if (!isTerminal(row) && !row.started) {
          // The relay no longer holds it (e.g. a server restart): it can never run, so settle it.
          await markNotStarted(jobId, 'cancelled', 'cancelled by the agent', ctx.context);
          return `Job ${jobId} was cancelled before it started. Nothing ran.`;
        }

        return `Job ${jobId} is already ${row.status}; there is nothing to cancel.`;
      }

      default:
        return `Unknown bridge_job action "${String(action)}". Use status, wait or cancel.`;
    }
  } catch (error) {
    logger.error(`bridge_job ${action} ${jobId} failed: ${error instanceof Error ? error.message : String(error)}`);
    return `The Unity Bridge could not ${action} job ${jobId}: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/*
 * ---------------------------------------------------------------------------------------------
 * Turn-level helpers (proxy wiring)
 * ---------------------------------------------------------------------------------------------
 */

/**
 * Which paired device (if any) this turn may drive (D54 — there is no project link). The user's
 * present, non-revoked devices are candidates and the most recently seen one wins; with devices but none
 * present the turn is `offline`; with none it is `none`. Offered only on turns with a project, because a
 * job is recorded under the project id.
 */
export async function resolveBridgeTurn(input: {
  user: { id: string };
  projectId?: string;
  context: unknown;
}): Promise<{ state: 'none' | 'disabled' | 'offline' | 'online'; device?: BridgeDeviceRow; hello?: BridgeHello }> {
  if (!input.projectId) {
    return { state: 'none' };
  }

  if (!isBridgeEnabled(input.context)) {
    return { state: 'disabled' };
  }

  try {
    const picked = pickBridgeDevice(await getBridgeStore(input.context).listDevices(input.user.id), input.user.id);

    if (picked.state === 'online') {
      return { ...picked, hello: deviceHello(picked.device.id) ?? picked.device.capabilities };
    }

    return picked;
  } catch (error) {
    // A store outage must not take the turn down — the bridge is simply not offered.
    logger.warn(`resolveBridgeTurn failed: ${error instanceof Error ? error.message : String(error)}`);
    return { state: 'none' };
  }
}

/**
 * THE device rule (D54), shared by the turn and the panel so they can never disagree: revoked rows and
 * other users' rows are ignored; the most recently seen PRESENT device wins (`online`); with devices but
 * none present, the most recently seen one is reported (`offline`); with none, `none`.
 */
export function pickBridgeDevice(
  rows: BridgeDeviceRow[],
  userId: string,
): { state: 'none' } | { state: 'online' | 'offline'; device: BridgeDeviceRow } {
  const devices = rows.filter((device) => !device.revokedAt && device.userId === userId);

  if (devices.length === 0) {
    return { state: 'none' };
  }

  const present = devices
    .filter((device) => isDevicePresent(device.id))
    .sort((a, b) => deviceLastSeen(b.id) - deviceLastSeen(a.id))[0];

  if (present) {
    return { state: 'online', device: present };
  }

  return { state: 'offline', device: [...devices].sort((a, b) => storedLastSeen(b) - storedLastSeen(a))[0] };
}

/** The stored last-seen (or, never seen, the pairing time) as epoch ms; unparseable → 0. */
function storedLastSeen(device: BridgeDeviceRow): number {
  const seen = Date.parse(device.lastSeenAt ?? device.createdAt);

  return Number.isFinite(seen) ? seen : 0;
}

/** Up to 10 rows with finishedAt && !reportedAt from listJobs(projectId, 25); stamps reportedAt on each. */
export async function takeFinishedJobsForNote(projectId: string, context: unknown): Promise<BridgeJobRow[]> {
  try {
    const store = getBridgeStore(context);
    const rows = (await store.listJobs(projectId, 25)).filter((row) => row.finishedAt && !row.reportedAt).slice(0, 10);
    const reportedAt = new Date().toISOString();

    for (const row of rows) {
      await withJobLock(row.id, async () => {
        const current = await store.getJob(row.id);

        if (current && !current.reportedAt) {
          await store.putJob({ ...current, reportedAt });
        }
      });
    }

    // listJobs is newest first; the note reads in the order things happened.
    return rows.reverse();
  } catch (error) {
    logger.warn(`takeFinishedJobsForNote failed: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}
