/**
 * The Unity Bridge operation pipeline — money-path tests (SPEC §4.17, §4.6, spec/billing.md, D10–D13, D16).
 *
 * Real relay with fake timers, a real FsLedger and FsBridgeStore in a tmp dir, the generations store
 * captured. The helper is simulated with `pollBridgeJobs` + `deliverBridgeEvent`, exactly the calls its
 * routes make. Every rule here spends or protects real money and fails silently when wrong.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FsLedger, setLedger } from '~/lib/.server/billing/ledger';
import { setGenerationStore, type GenerationStore, type GenerationUpsert } from '~/lib/.server/billing/generations';
import { deliverClientToolResult } from '~/lib/.server/agent/mcp-relay';
import { BRIDGE_PICKUP_TIMEOUT_MS, BRIDGE_SYNC_WAIT_MS, type BridgeOperation } from '~/lib/bridge/protocol';
import type { BridgeLink } from '~/lib/.server/projects/types';
import { cancelGenerationBridgeJobs, deliverBridgeEvent, pollBridgeJobs, resetBridgeRelayForTests } from './relay';
import { FsBridgeStore, setBridgeStore } from './store';
import {
  jobControl,
  runBridgeOperation,
  settleDropped,
  type BridgeRunContext,
  type BridgeToolOutcome,
  type BridgeUiEvent,
} from './service';

const USER = 'user_1';
const DEVICE = 'dev_1';
const PROJECT = 'proj_1';
const GEN = 'gen_1';

/* The oauth.spec trap: `env()` falls back to process.env / .env.local. Every money and bridge var is stubbed. */
const ENV = [
  'BILLING_ENFORCED',
  'CREDIT_UNIT_COST_USD',
  'CREDIT_MARGIN',
  'CREATION_FLAT_CREDITS',
  'UNITY_BRIDGE_ENABLED',
  'BRIDGE_COMMAND_CREDITS',
  'BRIDGE_SCRIPT_CREDITS',
  'BRIDGE_JOB_CREDITS',
] as const;

let tmp: string;
let ledger: FsLedger;
let store: FsBridgeStore;
let upserts: GenerationUpsert[];
let events: BridgeUiEvent[];

const link = (overrides: Partial<BridgeLink> = {}): BridgeLink => ({
  deviceId: DEVICE,
  unityProjectKey: 'key_1',
  unityProjectName: 'My Level',
  allowScripts: false,
  linkedAt: '2026-09-29T00:00:00.000Z',
  ...overrides,
});

function ctx(overrides: Partial<BridgeRunContext> = {}): BridgeRunContext {
  return {
    userId: USER,
    projectId: PROJECT,
    generationId: GEN,
    toolCallId: 'call_1',
    link: link(),
    deviceId: DEVICE,
    context: {},
    emit: (event) => void events.push(event),
    ...overrides,
  };
}

const SET_TRANSFORM: BridgeOperation = { kind: 'unity.command', name: 'set_transform', params: {} };

/** Real event-loop turns (setImmediate is not faked), so fs I/O completes while setTimeout is frozen. */
async function until(predicate: () => boolean | Promise<boolean>, tries = 2000): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (await predicate()) {
      return;
    }

    await new Promise((resolve) => setImmediate(resolve));
  }

  throw new Error('condition never became true');
}

const queuedJobId = () =>
  events.find((e) => e.type === 'bridge-job' && e.status === 'queued') as
    | Extract<BridgeUiEvent, { type: 'bridge-job' }>
    | undefined;

async function waitQueued(): Promise<string> {
  await until(() => Boolean(queuedJobId()));
  return queuedJobId()!.jobId;
}

/** The helper picks up everything queued (the queue is non-empty, so this returns without parking). */
async function pickUp() {
  return pollBridgeJobs(DEVICE, 0);
}

async function rows(reason?: string) {
  const all = await ledger.list(USER, 100);
  return reason ? all.filter((row) => row.reason === reason) : all;
}

async function grant(credits = 100) {
  await ledger.append({ userId: USER, delta: credits, reason: 'grant' });
}

/** Run one operation to completion as the helper would: pick up, started, final. */
async function runToFinal(op: BridgeOperation, result = { ok: true, text: 'done' }, c = ctx()) {
  const pending = runBridgeOperation(op, 'label', c);
  const jobId = await waitQueued();
  await pickUp();
  expect(deliverBridgeEvent(DEVICE, { jobId, type: 'started' })).toBe(true);
  expect(deliverBridgeEvent(DEVICE, { jobId, type: 'final', result })).toBe(true);

  return { jobId, outcome: await pending };
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

  for (const key of ENV) {
    vi.stubEnv(key, undefined as unknown as string);
  }

  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-service-'));
  ledger = new FsLedger(path.join(tmp, 'ledger'));
  setLedger(ledger);
  store = new FsBridgeStore(path.join(tmp, 'bridge'));
  setBridgeStore(store);

  upserts = [];
  events = [];
  setGenerationStore({
    upsert: async (row: GenerationUpsert) => void upserts.push(row),
    list: async () => [],
  } as unknown as GenerationStore);

  resetBridgeRelayForTests();
});

afterEach(async () => {
  resetBridgeRelayForTests();
  setLedger(undefined);
  setGenerationStore(undefined);
  setBridgeStore(null);
  vi.unstubAllEnvs();
  vi.useRealTimers();
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('runBridgeOperation', () => {
  it('an executed call is debited once, never refunded, and returns the result text', async () => {
    await grant();

    const { jobId, outcome } = await runToFinal(SET_TRANSFORM, { ok: true, text: 'moved' });

    expect(outcome).toBe('moved');

    const debits = await rows('bridge');
    expect(debits).toHaveLength(1);
    expect(debits[0].delta).toBe(-1);
    expect(debits[0].generationId).toBe(jobId);
    expect(await rows('refund')).toHaveLength(0);
    expect(upserts[0]).toMatchObject({ id: jobId, model: 'unity-bridge', provider: 'bridge', status: 'running' });

    await until(async () => (await store.getJob(jobId))?.status === 'succeeded');
    expect((await store.getJob(jobId))?.started).toBe(true);
  });

  it('a free call (unity.list) writes no ledger rows and no generations anchor', async () => {
    await grant();

    const { outcome } = await runToFinal({ kind: 'unity.list', query: 'transform' });

    expect(outcome).toBe('done');
    expect(await rows('bridge')).toHaveLength(0);
    expect(await rows('refund')).toHaveLength(0);
    expect(upserts).toHaveLength(0);
  });

  it('a pickup timeout refunds exactly once and marks the row cancelled', async () => {
    await grant();

    const pending = runBridgeOperation(SET_TRANSFORM, 'label', ctx());
    const jobId = await waitQueued();
    await vi.advanceTimersByTimeAsync(BRIDGE_PICKUP_TIMEOUT_MS + 1);

    expect(await pending).toMatch(/did not pick up the job within 30 s/);
    expect(await rows('bridge')).toHaveLength(1);

    const refunds = await rows('refund');
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatchObject({ delta: 1, note: `bridge:${jobId}` });
    expect((await store.getJob(jobId))?.status).toBe('cancelled');
  });

  it('a helper `refused` refunds once and marks the row refused', async () => {
    await grant();

    const pending = runBridgeOperation(SET_TRANSFORM, 'label', ctx());
    const jobId = await waitQueued();
    await pickUp();
    expect(deliverBridgeEvent(DEVICE, { jobId, type: 'refused', reason: 'Toolkit too old' })).toBe(true);

    expect(await pending).toBe(
      'The Unity Bridge helper refused to run this: Toolkit too old. Nothing ran and the credits were refunded.',
    );
    expect(await rows('bridge')).toHaveLength(1);
    expect(await rows('refund')).toHaveLength(1);
    expect((await store.getJob(jobId))?.status).toBe('refused');
  });

  it('a final ok:false is charged and reported as a failure', async () => {
    await grant();

    const { outcome } = await runToFinal(SET_TRANSFORM, { ok: false, text: 'no such object' });

    expect(outcome).toBe('The operation ran but reported a failure:\nno such object');
    expect(await rows('bridge')).toHaveLength(1);
    expect(await rows('refund')).toHaveLength(0);
  });

  it('a script with Allow scripts off is refused with a sentence and never debited', async () => {
    await grant();

    const outcome = await runBridgeOperation(
      { kind: 'unity.script', source: 'public static class B { public static void Run() {} }', entry: 'B.Run' },
      'unity_run_script B.Run',
      ctx(),
    );

    expect(outcome).toMatch(/Allow scripts/);
    expect(await rows('bridge')).toHaveLength(0);
    expect(events).toHaveLength(0);
  });

  it('consent denied → nothing charged, nothing dispatched', async () => {
    await grant();

    const pending = runBridgeOperation(
      { kind: 'unity.command', name: 'delete_gameobject', params: {} },
      'unity_command delete_gameobject',
      ctx(),
    );

    await until(() => events.some((e) => e.type === 'bridge-consent'));
    expect(events[0]).toMatchObject({ type: 'bridge-consent', toolCallId: 'call_1', target: 'My Level' });
    expect(
      deliverClientToolResult({
        generationId: GEN,
        toolCallId: 'consent:call_1',
        userId: USER,
        result: { approved: false },
      }),
    ).toBe(true);

    expect(await pending).toMatch(/did not allow this operation/);
    expect(await rows('bridge')).toHaveLength(0);
    expect(upserts).toHaveLength(0);
  });

  it('consent approved → the dispatch carries consentGranted: true, debited after the answer', async () => {
    await grant();

    const pending = runBridgeOperation(
      { kind: 'unity.command', name: 'delete_gameobject', params: {} },
      'unity_command delete_gameobject',
      ctx(),
    );

    await until(() => events.some((e) => e.type === 'bridge-consent'));
    expect(await rows('bridge')).toHaveLength(0);
    deliverClientToolResult({
      generationId: GEN,
      toolCallId: 'consent:call_1',
      userId: USER,
      result: { approved: true },
    });

    const jobId = await waitQueued();
    const poll = await pickUp();

    expect(poll.jobs).toHaveLength(1);
    expect(poll.jobs[0].consentGranted).toBe(true);

    deliverBridgeEvent(DEVICE, { jobId, type: 'started' });
    deliverBridgeEvent(DEVICE, { jobId, type: 'final', result: { ok: true, text: 'deleted' } });
    expect(await pending).toBe('deleted');
    expect(await rows('bridge')).toHaveLength(1);
  });

  it('insufficient balance with billing enforced → a sentence, no dispatch', async () => {
    vi.stubEnv('BILLING_ENFORCED', 'true');

    const outcome = await runBridgeOperation(SET_TRANSFORM, 'unity_command set_transform', ctx());

    expect(outcome).toBe(
      'Not enough credits for this Unity operation (1 credits). The user can add credits and try again.',
    );
    expect(events).toHaveLength(0);
    expect(await store.listJobs(PROJECT, 10)).toHaveLength(0);
  });

  it('still running at 60 s → a sentence naming the job; bridge_job wait then returns the final', async () => {
    await grant();

    const pending = runBridgeOperation(SET_TRANSFORM, 'label', ctx());
    const jobId = await waitQueued();
    await pickUp();
    deliverBridgeEvent(DEVICE, { jobId, type: 'started' });
    await vi.advanceTimersByTimeAsync(BRIDGE_SYNC_WAIT_MS + 1);

    const first = (await pending) as string;
    expect(first).toContain(jobId);
    expect(first).toMatch(/Still running/);

    const waiting = jobControl('wait', jobId, 60, { userId: USER, context: {} });
    deliverBridgeEvent(DEVICE, { jobId, type: 'final', result: { ok: true, text: 'exported' } });

    expect(await waiting).toBe('exported');
    expect(await rows('refund')).toHaveLength(0);
  });

  it('a capture returns the image alongside the text', async () => {
    await grant();

    const { outcome } = await runToFinal({ kind: 'unity.capture', view: 'game', width: 1024, height: 576 }, {
      ok: true,
      text: 'captured',
      image: { base64: 'AAAA', mimeType: 'image/png' },
    } as never);

    expect(outcome).toEqual({
      text: 'captured',
      image: { base64: 'AAAA', mimeType: 'image/png' },
    } satisfies BridgeToolOutcome);
  });
});

describe('settlement (D13)', () => {
  it('settleDropped twice refunds once', async () => {
    await grant();

    const pending = runBridgeOperation(SET_TRANSFORM, 'label', ctx());
    const jobId = await waitQueued();
    const ids = cancelGenerationBridgeJobs(GEN);

    expect(ids).toEqual([jobId]);
    await settleDropped(ids, {});
    await settleDropped(ids, {});
    await pending;

    const refunds = await rows('refund');
    expect(refunds).toHaveLength(1);
    expect(refunds[0].note).toBe(`bridge:${jobId}`);
  });

  it('cancel then pickup timeout → exactly ONE refund row', async () => {
    await grant();

    const pending = runBridgeOperation(SET_TRANSFORM, 'label', ctx());
    const jobId = await waitQueued();

    expect(await jobControl('cancel', jobId, 0, { userId: USER, context: {} })).toMatch(/cancelled before it started/);
    await vi.advanceTimersByTimeAsync(BRIDGE_PICKUP_TIMEOUT_MS + 1);
    await pending;

    const refunds = await rows('refund');
    expect(refunds).toHaveLength(1);
    expect(refunds[0].note).toBe(`bridge:${jobId}`);
    expect((await store.getJob(jobId))?.status).toBe('cancelled');
  });

  it('a late `started` after the pickup timeout changes nothing — no second refund, no charge revived', async () => {
    await grant();

    const pending = runBridgeOperation(SET_TRANSFORM, 'label', ctx());
    const jobId = await waitQueued();
    await pickUp();
    await vi.advanceTimersByTimeAsync(BRIDGE_PICKUP_TIMEOUT_MS + 1);
    await pending;

    expect(deliverBridgeEvent(DEVICE, { jobId, type: 'started' })).toBe(false);
    expect(deliverBridgeEvent(DEVICE, { jobId, type: 'final', result: { ok: true, text: 'late' } })).toBe(false);
    await settleDropped([jobId], {});

    const row = await store.getJob(jobId);
    expect(row?.status).toBe('cancelled');
    expect(row?.started).toBe(false);
    expect(await rows('refund')).toHaveLength(1);
  });

  it('a duplicate `started` is idempotent — never re-charges, never regresses a row', async () => {
    await grant();

    const { jobId } = await runToFinal(SET_TRANSFORM);
    await until(async () => (await store.getJob(jobId))?.status === 'succeeded');

    // The relay refuses events after a final; the service's own rule is exercised through a live job below.
    expect(deliverBridgeEvent(DEVICE, { jobId, type: 'started' })).toBe(false);

    const pending = runBridgeOperation(SET_TRANSFORM, 'label', ctx({ toolCallId: 'call_2' }));
    await until(() => events.filter((e) => e.type === 'bridge-job' && e.status === 'queued').length === 2);

    const second = (events.filter((e) => e.type === 'bridge-job' && e.status === 'queued')[1] as { jobId: string })
      .jobId;
    await pickUp();
    deliverBridgeEvent(DEVICE, { jobId: second, type: 'started' });
    deliverBridgeEvent(DEVICE, { jobId: second, type: 'started' });
    deliverBridgeEvent(DEVICE, { jobId: second, type: 'final', result: { ok: true, text: 'ok' } });
    await pending;
    await until(async () => (await store.getJob(second))?.status === 'succeeded');

    expect(await rows('bridge')).toHaveLength(2);
    expect(await rows('refund')).toHaveLength(0);
  });

  it('unmetered and the debit fails → the row stores 0 credits and a cancel writes no refund', async () => {
    // No grant: the 'bridge' append would overdraw and is refused; billing is not enforced.
    const pending = runBridgeOperation(SET_TRANSFORM, 'label', ctx());
    const jobId = await waitQueued();

    expect((await store.getJob(jobId))?.credits).toBe(0);
    await jobControl('cancel', jobId, 0, { userId: USER, context: {} });
    await vi.advanceTimersByTimeAsync(BRIDGE_PICKUP_TIMEOUT_MS + 1);
    await pending;

    expect(await rows()).toHaveLength(0);
    expect((await store.getJob(jobId))?.status).toBe('cancelled');
  });
});

describe('jobControl', () => {
  it('status formats the row; another user sees nothing', async () => {
    await grant();

    const { jobId } = await runToFinal(SET_TRANSFORM, { ok: true, text: 'moved' });
    await until(async () => (await store.getJob(jobId))?.status === 'succeeded');

    expect(await jobControl('status', jobId, 0, { userId: USER, context: {} })).toBe(
      `Job ${jobId} (label): succeeded, 1 credit.\nmoved`,
    );
    expect(await jobControl('status', jobId, 0, { userId: 'someone_else', context: {} })).toMatch(
      /No Unity Bridge job/,
    );
  });
});
