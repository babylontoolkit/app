/**
 * Unity Bridge service (SPEC §4.17, §4.6, `spec/billing.md`) — the operation pipeline a bridge tool call
 * runs: validate → tier → (consent) → price → debit → dispatch → wait for `started` → wait for the result.
 *
 * Money rules (D10–D13, D16), each failing silently when wrong:
 *   - consent comes FIRST: a consent-tier call is never debited before the user said yes (D16);
 *   - a charge stands once the helper reports `started`; everything else is refunded EXACTLY ONCE by
 *     ONE function, `settleNotStarted` (D13). It writes the terminal status BEFORE the refund, and it
 *     never touches a terminal row or a started one (latch 1). The ledger's partial unique index on the
 *     note `bridge:<jobId>` is latch 2 (`billing.ts`);
 *   - every row write goes through one rule: never overwrite a terminal row;
 *   - nothing on a tool path throws: every outcome is a sentence for the model.
 *
 * All writes for one job are serialised through an in-process chain (`withJobLock`). The relay lives on
 * ONE server instance (D5), so this makes latch 1 a real guarantee there rather than a read-then-write
 * check two settlers (a cancel and a pickup timeout, D13's race) could both pass.
 */
import { createScopedLogger } from '~/utils/logger';
import {
  BRIDGE_CONSENT_TIMEOUT_MS,
  BRIDGE_JOB_WAIT_MAX_S,
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
import { creditsFor } from '~/lib/bridge/pricing';
import { getGenerationStore } from '~/lib/.server/billing/generations';
import { getMonitor } from '~/lib/.server/monitoring';
import { recordRefundOutcome } from '~/lib/.server/monitoring/paid-path-rates';
import { awaitClientToolResult } from '~/lib/.server/agent/mcp-relay';
import type { BridgeLink } from '~/lib/.server/projects/types';
import { BridgeRefusedError, isBridgeEnabled, mintId } from './auth';
import { anchorAndDebit, bridgePrices, refundBridgeJob } from './billing';
import { cancelBridgeJob, deviceHello, enqueueBridgeJob, getJobHandle, isDevicePresent } from './relay';
import { getBridgeStore, type BridgeDeviceRow, type BridgeJobRow } from './store';

const logger = createScopedLogger('bridge.service');

export interface BridgeRunContext {
  userId: string;
  projectId: string;
  generationId: string;
  toolCallId: string;
  link: BridgeLink;
  deviceId: string;
  abortSignal?: AbortSignal;
  context: unknown;
  emit: (event: BridgeUiEvent) => void;
}

export type BridgeUiEvent =
  | { type: 'bridge-consent'; toolCallId: string; operation: string; tier: 'consent'; target: string }
  | { type: 'bridge-job'; jobId: string; status: BridgeJobStatus; label: string; line?: string; credits: number };

export type BridgeToolOutcome = string | { text: string; image: { base64: string; mimeType: 'image/png' } };

const TERMINAL: ReadonlySet<BridgeJobStatus> = new Set(['succeeded', 'failed', 'refused', 'cancelled']);

const isTerminal = (row: BridgeJobRow) => TERMINAL.has(row.status);

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

/** Mark the generations anchor terminal. Only a priced job has one (`anchorAndDebit`). */
async function settleAnchor(row: BridgeJobRow, status: 'completed' | 'failed', context: unknown): Promise<void> {
  if (row.credits <= 0) {
    return;
  }

  await getGenerationStore(context)
    .upsert({ id: row.id, userId: row.userId, model: 'unity-bridge', status })
    .catch((error) => logger.warn(`bridge anchor ${row.id} not updated: ${(error as Error).message}`));
}

/*
 * ---------------------------------------------------------------------------------------------
 * The ONE refund writer (D13)
 * ---------------------------------------------------------------------------------------------
 */

/** Caller holds the job lock. Returns true when this call settled (and refunded) the job. */
async function settleNotStartedLocked(
  jobId: string,
  status: 'cancelled' | 'refused',
  reason: string,
  context: unknown,
): Promise<boolean> {
  const store = getBridgeStore(context);
  const row = await store.getJob(jobId);

  if (!row) {
    logger.warn(`settleNotStarted: no row for bridge job ${jobId}`);
    return false;
  }

  // Latch 1: a terminal row is already settled; a started job's charge stands.
  if (isTerminal(row) || row.started) {
    return false;
  }

  const settled: BridgeJobRow = { ...row, status, error: reason, finishedAt: new Date().toISOString() };

  // The status FIRST, then the refund: a crash between the two leaves an un-refunded terminal row (an alertable, auditable state) rather than a refunded live one.
  await store.putJob(settled);
  await refundBridgeJob({ jobId, userId: row.userId, credits: row.credits, reason, context });
  await settleAnchor(row, 'failed', context);

  return true;
}

/** THE refund writer (D13). Terminal row or started → no-op. Writes the status first, then refunds row.credits. */
export async function settleNotStarted(
  jobId: string,
  status: 'cancelled' | 'refused',
  reason: string,
  context: unknown,
): Promise<void> {
  await withJobLock(jobId, () => settleNotStartedLocked(jobId, status, reason, context));
}

/** settleNotStarted(id, 'cancelled', 'cancelled before it started', context) for each id; never throws. */
export async function settleDropped(jobIds: string[], context: unknown): Promise<void> {
  for (const jobId of jobIds) {
    try {
      await settleNotStarted(jobId, 'cancelled', 'cancelled before it started', context);
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
  credits: number;
  context: unknown;
  emit: (event: BridgeUiEvent) => void;
}): (event: BridgeJobEvent) => Promise<void> {
  const { jobId, label, credits, context, emit } = input;
  const store = () => getBridgeStore(context);
  const job = (status: BridgeJobStatus, line?: string): BridgeUiEvent => ({
    type: 'bridge-job',
    jobId,
    status,
    label,
    credits,
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
            await settleAnchor(row, 'completed', context);

            if (row.credits > 0) {
              recordRefundOutcome(getMonitor(context), 'bridge', false);
            }

            safeEmit(emit, job(status));

            return;
          }

          case 'refused': {
            const row = await store().getJob(jobId);

            if (!row || isTerminal(row)) {
              return;
            }

            if (row.started) {
              // Refused after it began — the charge stands (D13); record the failure, refund nothing.
              await store().putJob({
                ...row,
                status: 'failed',
                error: event.reason,
                finishedAt: new Date().toISOString(),
              });
              safeEmit(emit, job('failed'));

              return;
            }

            await settleNotStartedLocked(jobId, 'refused', event.reason, context);
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

  return final.image ? { text, image: final.image } : text;
}

function formatRow(row: BridgeJobRow): string {
  const detail = row.status === 'succeeded' || row.status === 'failed' ? row.resultText : row.error;
  const credits = row.credits === 1 ? '1 credit' : `${row.credits} credits`;

  return `Job ${row.id} (${row.operation}): ${row.status}, ${credits}.${detail ? `\n${detail}` : ''}`;
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

    if (tier === 'scripts' && !ctx.link.allowScripts) {
      return 'Scripts are switched off for this Unity link. Ask the user to turn on "Allow scripts" in the Unity Bridge panel (the cube icon), then try again.';
    }

    // D16: consent BEFORE any quote, debit or dispatch.
    if (tier === 'consent') {
      safeEmit(ctx.emit, {
        type: 'bridge-consent',
        toolCallId: ctx.toolCallId,
        operation: label,
        tier: 'consent',
        target: ctx.link.unityProjectName,
      });

      const answer = await awaitClientToolResult({
        generationId: ctx.generationId,
        toolCallId: 'consent:' + ctx.toolCallId,
        userId: ctx.userId,
        abortSignal: ctx.abortSignal,
        timeoutMs: BRIDGE_CONSENT_TIMEOUT_MS,
      });

      if (!(answer.result && (answer.result as { approved?: unknown }).approved === true)) {
        return `The user did not allow this operation (${label}). Nothing ran and nothing was charged.`;
      }
    }

    const credits = creditsFor(op, bridgePrices(ctx.context));
    const jobId = mintId('brg');
    let debited = 0;

    if (credits > 0) {
      try {
        ({ debited } = await anchorAndDebit({
          jobId,
          userId: ctx.userId,
          projectId: ctx.projectId,
          credits,
          label,
          context: ctx.context,
        }));
      } catch (error) {
        if (error instanceof BridgeRefusedError && error.statusCode === 402) {
          return `Not enough credits for this Unity operation (${credits} credits). The user can add credits and try again.`;
        }

        throw error;
      }
    }

    const store = getBridgeStore(ctx.context);

    await store.putJob({
      id: jobId,
      userId: ctx.userId,
      projectId: ctx.projectId,
      deviceId: ctx.deviceId,
      operation: label,
      tier,
      status: 'queued',
      credits: debited,
      started: false,
      createdAt: new Date().toISOString(),
    });
    safeEmit(ctx.emit, { type: 'bridge-job', jobId, status: 'queued', label, credits: debited });

    const handle = enqueueBridgeJob({
      deviceId: ctx.deviceId,
      userId: ctx.userId,
      generationId: ctx.generationId,
      dispatch: {
        jobId,
        op,
        unityProjectKey: ctx.link.unityProjectKey,
        allowScripts: ctx.link.allowScripts,
        consentGranted: tier === 'consent',
      },
      onEvent: makeOnEvent({ jobId, label, credits: debited, context: ctx.context, emit: ctx.emit }),
    });

    const started = await handle.waitStarted(BRIDGE_PICKUP_TIMEOUT_MS, ctx.abortSignal);

    if (!started) {
      const cancelled = cancelBridgeJob(jobId, ctx.userId);

      // It started in the gap between the timer and this line: the charge stands, wait for the result.
      if (cancelled !== 'signalled') {
        await settleNotStarted(jobId, 'cancelled', 'not picked up', ctx.context);
        safeEmit(ctx.emit, { type: 'bridge-job', jobId, status: 'cancelled', label, credits: debited });

        return 'The Unity Bridge helper did not pick up the job within 30 s. Nothing ran and the credits were refunded. Ask the user to check the helper is running.';
      }
    }

    const final = await handle.waitFinal(BRIDGE_SYNC_WAIT_MS, ctx.abortSignal);

    if (final === 'refused') {
      const row = await settledRow(jobId, ctx.context);

      return `The Unity Bridge helper refused to run this: ${row?.error ?? 'no reason given'}. Nothing ran and the credits were refunded.`;
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
          await settleNotStarted(jobId, 'cancelled', 'cancelled by the agent', ctx.context);
          return `Job ${jobId} was cancelled before it started. Nothing ran and the credits were refunded.`;
        }

        if (outcome === 'signalled') {
          return `Job ${jobId} had already started on the user's machine; a cancel was sent to the helper. A started job stays charged.`;
        }

        const row = await ownedRow(jobId, ctx.userId, ctx.context);

        if (!row) {
          return notFound(jobId);
        }

        if (!isTerminal(row) && !row.started) {
          // The relay no longer holds it (e.g. a server restart): it can never run, so settle it.
          await settleNotStarted(jobId, 'cancelled', 'cancelled by the agent', ctx.context);
          return `Job ${jobId} was cancelled before it started. Nothing ran and the credits were refunded.`;
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

export async function resolveBridgeTurn(input: {
  user: { id: string };
  projectId?: string;
  link?: BridgeLink;
  context: unknown;
}): Promise<{ state: 'none' | 'disabled' | 'offline' | 'online'; device?: BridgeDeviceRow; hello?: BridgeHello }> {
  if (!input.projectId || !input.link) {
    return { state: 'none' };
  }

  if (!isBridgeEnabled(input.context)) {
    return { state: 'disabled' };
  }

  try {
    const device = await getBridgeStore(input.context).getDevice(input.link.deviceId);

    if (!device || device.revokedAt || device.userId !== input.user.id) {
      return { state: 'none' };
    }

    if (isDevicePresent(device.id)) {
      return { state: 'online', device, hello: deviceHello(device.id) ?? device.capabilities };
    }

    return { state: 'offline', device };
  } catch (error) {
    // A store outage must not take the turn down — the bridge is simply not offered.
    logger.warn(`resolveBridgeTurn failed: ${error instanceof Error ? error.message : String(error)}`);
    return { state: 'none' };
  }
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
