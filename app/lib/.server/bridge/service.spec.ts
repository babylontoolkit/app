/**
 * The Unity Bridge operation pipeline (SPEC §4.17, D16, D53).
 *
 * Real relay with fake timers, a real FsLedger and FsBridgeStore in a tmp dir, the generations store
 * captured. The helper is simulated with `pollBridgeJobs` + `deliverBridgeEvent`, exactly the calls its
 * routes make.
 *
 * 🔴 D53 (owner, 2026-09-29): bridge operations are NOT billed separately — the model turn that drives
 * Unity/Blender is billed like any generation. The ledger here is REAL precisely so that a per-operation
 * charge coming back fails these tests: every path below asserts ZERO ledger rows and no generations anchor.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FsLedger, setLedger } from '~/lib/.server/billing/ledger';
import { setGenerationStore, type GenerationStore, type GenerationUpsert } from '~/lib/.server/billing/generations';
import { deliverClientToolResult } from '~/lib/.server/agent/mcp-relay';
import {
  BRIDGE_CONSENT_TIMEOUT_MS,
  BRIDGE_MAX_IMAGE_BASE64,
  BRIDGE_PICKUP_TIMEOUT_MS,
  BRIDGE_SYNC_WAIT_MS,
  type BridgeOperation,
} from '~/lib/bridge/protocol';
import {
  cancelGenerationBridgeJobs,
  deliverBridgeEvent,
  pollBridgeJobs,
  resetBridgeRelayForTests,
  touchDevice,
} from './relay';
import { FsBridgeStore, setBridgeStore, type BridgeDeviceRow } from './store';
import {
  CAPTURE_SHOWN_NOTE,
  jobControl,
  resolveBridgeTurn,
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
const ENV = ['BILLING_ENFORCED', 'CREDIT_UNIT_COST_USD', 'CREDIT_MARGIN', 'UNITY_BRIDGE_ENABLED'] as const;

let tmp: string;
let ledger: FsLedger;
let store: FsBridgeStore;
let upserts: GenerationUpsert[];
let events: BridgeUiEvent[];

/** A paired device row. D58: its Allow scripts switch starts OFF (`store.setDeviceAllowScripts` turns it). */
const device = (overrides: Partial<BridgeDeviceRow> = {}): BridgeDeviceRow => ({
  id: DEVICE,
  userId: USER,
  name: 'Studio Mac',
  os: 'darwin',
  tokenHash: `hash_${overrides.id ?? DEVICE}`,
  createdAt: '2026-09-29T00:00:00.000Z',
  ...overrides,
});

function ctx(overrides: Partial<BridgeRunContext> = {}): BridgeRunContext {
  return {
    userId: USER,
    projectId: PROJECT,
    generationId: GEN,
    toolCallId: 'call_1',
    deviceId: DEVICE,
    deviceName: 'Studio Mac',
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

/** Every ledger row for the user. D53: the bridge must never write one. */
async function rows() {
  return ledger.list(USER, 100);
}

/** The owner's rule, pinned: no ledger row and no generations anchor for a bridge job. */
async function expectNothingBilled() {
  expect(await rows()).toHaveLength(0);
  expect(upserts).toHaveLength(0);
}

/** Run one operation to completion as the helper would: pick up, started, final. */
async function runToFinal(op: BridgeOperation, result = { ok: true, text: 'done' }, c = ctx()) {
  const pending = runBridgeOperation(op, 'label', c);
  const jobId = await waitQueued();
  await pickUp();
  expect(deliverBridgeEvent(DEVICE, { jobId, type: 'started' })).toBe(true);
  expect(deliverBridgeEvent(DEVICE, { jobId, type: 'final', result })).toBe(true);

  const outcome = await pending;

  /*
   * The row write + UI event for `final` run under the job lock AFTER the waiter resolves. Wait for them,
   * or they land in the NEXT test's `events` array (a cross-test leak that made assertions flaky).
   */
  await until(() =>
    events.some(
      (e) => e.type === 'bridge-job' && e.jobId === jobId && (e.status === 'succeeded' || e.status === 'failed'),
    ),
  );

  return { jobId, outcome };
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
  it('an executed call returns the result text and writes the row succeeded', async () => {
    const { jobId, outcome } = await runToFinal(SET_TRANSFORM, { ok: true, text: 'moved' });

    expect(outcome).toBe('moved');

    await until(async () => (await store.getJob(jobId))?.status === 'succeeded');
    expect((await store.getJob(jobId))?.started).toBe(true);
    await expectNothingBilled();
  });

  it('a pickup timeout marks the row cancelled with a sentence', async () => {
    const pending = runBridgeOperation(SET_TRANSFORM, 'label', ctx());
    const jobId = await waitQueued();
    await vi.advanceTimersByTimeAsync(BRIDGE_PICKUP_TIMEOUT_MS + 1);

    expect(await pending).toBe(
      'The Unity Bridge helper did not pick up the job within 30 s. Nothing ran. Ask the user to check the helper is running.',
    );
    expect((await store.getJob(jobId))?.status).toBe('cancelled');
    await expectNothingBilled();
  });

  it('a helper `refused` marks the row refused', async () => {
    const pending = runBridgeOperation(SET_TRANSFORM, 'label', ctx());
    const jobId = await waitQueued();
    await pickUp();
    expect(deliverBridgeEvent(DEVICE, { jobId, type: 'refused', reason: 'Toolkit too old' })).toBe(true);

    expect(await pending).toBe('The Unity Bridge helper refused to run this: Toolkit too old. Nothing ran.');
    expect((await store.getJob(jobId))?.status).toBe('refused');
    await expectNothingBilled();
  });

  it('a final ok:false is reported as a failure', async () => {
    const { outcome } = await runToFinal(SET_TRANSFORM, { ok: false, text: 'no such object' });

    expect(outcome).toBe('The operation ran but reported a failure:\nno such object');
    await expectNothingBilled();
  });

  it('consent denied → nothing dispatched', async () => {
    const pending = runBridgeOperation(
      { kind: 'unity.command', name: 'delete_gameobject', params: {} },
      'unity_command delete_gameobject',
      ctx(),
    );

    await until(() => events.some((e) => e.type === 'bridge-consent'));

    // No hello with a current project → the consent names the device.
    expect(events[0]).toMatchObject({ type: 'bridge-consent', toolCallId: 'call_1', target: 'Studio Mac' });

    // The prompt shows the exact operation, not the tool label (T25 step 4).
    expect(events[0]).toMatchObject({ operation: 'unity command delete_gameobject' });
    expect(
      deliverClientToolResult({
        generationId: GEN,
        toolCallId: 'consent:call_1',
        userId: USER,
        result: { approved: false },
      }),
    ).toBe(true);

    expect(await pending).toBe('The user did not allow this operation (unity_command delete_gameobject). Nothing ran.');
    expect(await store.listJobs(PROJECT, 10)).toHaveLength(0);
    expect(events.at(-1)).toEqual({ type: 'bridge-consent', toolCallId: 'call_1', closed: true });
    await expectNothingBilled();
  });

  it('an UNANSWERED consent (timeout) is not a refusal: its own sentence, the prompt closed, nothing ran', async () => {
    const pending = runBridgeOperation(
      { kind: 'unity.command', name: 'delete_gameobject', params: {} },
      'unity_command delete_gameobject',
      ctx(),
    );

    await until(() => events.some((e) => e.type === 'bridge-consent'));
    await vi.advanceTimersByTimeAsync(BRIDGE_CONSENT_TIMEOUT_MS + 1);

    const outcome = await pending;
    expect(outcome).toBe(
      "The user did not answer the consent prompt in time (unity_command delete_gameobject); nothing ran. Ask them again if it's still needed.",
    );
    expect(outcome).not.toMatch(/did not allow/);
    expect(events.at(-1)).toEqual({ type: 'bridge-consent', toolCallId: 'call_1', closed: true });
    expect(await store.listJobs(PROJECT, 10)).toHaveLength(0);
    await expectNothingBilled();
  });

  it('a Stop while the consent is open → the unanswered sentence and a closed part', async () => {
    const abort = new AbortController();
    const pending = runBridgeOperation(
      { kind: 'unity.command', name: 'delete_gameobject', params: {} },
      'unity_command delete_gameobject',
      ctx({ abortSignal: abort.signal }),
    );

    await until(() => events.some((e) => e.type === 'bridge-consent'));
    abort.abort();

    expect(await pending).toMatch(/^The user did not answer the consent prompt in time/);
    expect(events.filter((e) => e.type === 'bridge-consent' && 'closed' in e)).toHaveLength(1);
  });

  it('consent approved → the dispatch carries consentGranted: true, queued only after the answer', async () => {
    const pending = runBridgeOperation(
      { kind: 'unity.command', name: 'delete_gameobject', params: {} },
      'unity_command delete_gameobject',
      ctx(),
    );

    await until(() => events.some((e) => e.type === 'bridge-consent'));
    expect(await store.listJobs(PROJECT, 10)).toHaveLength(0);
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
    await expectNothingBilled();
  });

  it('billing enforced with a ZERO balance still runs the operation — the bridge has no credit gate (D53)', async () => {
    vi.stubEnv('BILLING_ENFORCED', 'true');

    const { outcome } = await runToFinal(SET_TRANSFORM, { ok: true, text: 'moved' });

    expect(outcome).toBe('moved');
    await expectNothingBilled();
  });

  it("a script dispatch carries the device's switch when ON (D58): allowScripts true, zero ledger rows", async () => {
    await store.putDevice(device());
    await store.setDeviceAllowScripts(DEVICE, true);

    const pending = runBridgeOperation(
      { kind: 'unity.script', source: 'public static class B { public static void Run() {} }', entry: 'B.Run' },
      'unity_run_script B.Run',
      ctx(),
    );
    const jobId = await waitQueued();
    const poll = await pickUp();

    expect(poll.jobs[0].allowScripts).toBe(true);
    expect(poll.jobs[0]).not.toHaveProperty('unityProjectKey');

    deliverBridgeEvent(DEVICE, { jobId, type: 'started' });
    deliverBridgeEvent(DEVICE, { jobId, type: 'final', result: { ok: true, text: 'script ok' } });

    expect(await pending).toBe('script ok');
    await until(async () => (await store.getJob(jobId))?.status === 'succeeded');
    await expectNothingBilled();
  });

  it("a script dispatch carries the device's switch when the user turned it OFF (D58): allowScripts false, the helper's refusal is reported", async () => {
    await store.putDevice(device());
    await store.setDeviceAllowScripts(DEVICE, false);

    const pending = runBridgeOperation(
      { kind: 'unity.script', source: 'class A {}', entry: 'A.Run' },
      'unity_run_script A.Run',
      ctx(),
    );
    const jobId = await waitQueued();
    const poll = await pickUp();

    expect(poll.jobs[0].allowScripts).toBe(false);

    const refusal =
      'Scripts are off for this computer — the user can turn on Allow scripts in the Unity Bridge dialog (the cube icon in the App Builder).';

    deliverBridgeEvent(DEVICE, { jobId, type: 'refused', reason: refusal });
    expect(String(await pending)).toContain('turn on Allow scripts in the Unity Bridge dialog');
    await until(async () => (await store.getJob(jobId))?.status === 'refused');
    await expectNothingBilled();
  });

  it('the switch is read AT DISPATCH: turning it on mid-turn applies to the next call of the same turn', async () => {
    await store.putDevice(device());
    await store.setDeviceAllowScripts(DEVICE, false);

    const first = runBridgeOperation(SET_TRANSFORM, 'label', ctx());
    const firstId = await waitQueued();

    expect((await pickUp()).jobs[0].allowScripts).toBe(false);
    deliverBridgeEvent(DEVICE, { jobId: firstId, type: 'started' });
    deliverBridgeEvent(DEVICE, { jobId: firstId, type: 'final', result: { ok: true, text: 'ok' } });
    await first;
    await until(async () => (await store.getJob(firstId))?.status === 'succeeded');

    await store.setDeviceAllowScripts(DEVICE, true);
    events = [];

    const second = runBridgeOperation(SET_TRANSFORM, 'label', ctx({ toolCallId: 'call_2' }));
    const secondId = await waitQueued();

    expect((await pickUp()).jobs[0].allowScripts).toBe(true);
    deliverBridgeEvent(DEVICE, { jobId: secondId, type: 'started' });
    deliverBridgeEvent(DEVICE, { jobId: secondId, type: 'final', result: { ok: true, text: 'ok' } });
    await second;
    await until(async () => (await store.getJob(secondId))?.status === 'succeeded');
  });

  it('a device row that cannot be read dispatches allowScripts:false — never absent-means-on', async () => {
    // No device row at all (e.g. removed between the turn start and this call).
    const pending = runBridgeOperation(SET_TRANSFORM, 'label', ctx());
    const jobId = await waitQueued();

    expect((await pickUp()).jobs[0].allowScripts).toBe(false);
    deliverBridgeEvent(DEVICE, { jobId, type: 'started' });
    deliverBridgeEvent(DEVICE, { jobId, type: 'final', result: { ok: true, text: 'ok' } });
    await pending;
    await until(async () => (await store.getJob(jobId))?.status === 'succeeded');
  });

  it('a helper started with --no-scripts refuses a script itself; the server reports that and nothing ran', async () => {
    await store.putDevice(device());

    const pending = runBridgeOperation(
      { kind: 'unity.script', source: 'class A {}', entry: 'A.Run' },
      'unity_run_script A.Run',
      ctx(),
    );
    const jobId = await waitQueued();
    await pickUp();

    deliverBridgeEvent(DEVICE, {
      jobId,
      type: 'refused',
      reason:
        'Scripts are disabled on this computer (--no-scripts) — the Allow scripts switch has no effect; the user must re-run the install command from the Unity Bridge dialog without --no-scripts.',
    });

    expect(await pending).toMatch(/--no-scripts/);
    await until(async () => (await store.getJob(jobId))?.status === 'refused');
    await expectNothingBilled();
  });

  it("consent names the helper's current Unity project when it reports one", async () => {
    touchDevice(DEVICE, {
      protocol: 2,
      helperVersion: '1.0.0',
      os: 'darwin',
      projectsDir: 'Unity',
      unityProjects: [{ key: 'k1', name: 'Racer' }],
      currentProject: 'Racer',
      scriptsDisabledLocally: false,
    });

    const pending = runBridgeOperation(
      { kind: 'unity.command', name: 'delete_gameobject', params: {} },
      'unity_command delete_gameobject',
      ctx(),
    );

    await until(() => events.some((e) => e.type === 'bridge-consent'));
    expect(events[0]).toMatchObject({ type: 'bridge-consent', target: 'Racer' });
    deliverClientToolResult({
      generationId: GEN,
      toolCallId: 'consent:call_1',
      userId: USER,
      result: { approved: false },
    });
    await pending;
  });

  it('a long job (bt_export_level) runs with zero ledger rows', async () => {
    const { outcome } = await runToFinal(
      { kind: 'unity.command', name: 'bt_export_level', params: {} },
      {
        ok: true,
        text: 'exported',
      },
    );

    expect(outcome).toBe('exported');
    await expectNothingBilled();
  });

  it('still running at 60 s → a sentence naming the job; bridge_job wait then returns the final', async () => {
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
    await expectNothingBilled();
  });

  it('a capture returns the image alongside the text', async () => {
    const { outcome } = await runToFinal({ kind: 'unity.capture', view: 'game', width: 1024, height: 576 }, {
      ok: true,
      text: 'captured',
      image: { base64: 'AAAA', mimeType: 'image/png' },
    } as never);

    expect(outcome).toEqual({
      text: `captured\n${CAPTURE_SHOWN_NOTE}`,
      image: { base64: 'AAAA', mimeType: 'image/png' },
    } satisfies BridgeToolOutcome);
    expect(CAPTURE_SHOWN_NOTE).toBe('(The user sees this capture in a popup, not in the chat.)');
  });

  it("a finished capture's bridge-job part carries the image to the user; other parts never do", async () => {
    const { jobId } = await runToFinal({ kind: 'unity.capture', view: 'game', width: 1024, height: 576 }, {
      ok: true,
      text: 'captured',
      image: { base64: 'AAAA', mimeType: 'image/png' },
    } as never);

    const jobEvents = events.filter((e) => e.type === 'bridge-job' && e.jobId === jobId);
    const withImage = jobEvents.filter((e) => 'image' in e && e.image);

    expect(withImage).toEqual([
      {
        type: 'bridge-job',
        jobId,
        status: 'succeeded',
        label: 'label',
        image: { base64: 'AAAA', mimeType: 'image/png' },
      },
    ]);
  });

  it('an image over BRIDGE_MAX_IMAGE_BASE64 never reaches the client, and the text does not claim it was shown', async () => {
    const big = 'A'.repeat(BRIDGE_MAX_IMAGE_BASE64 + 1);
    const { outcome } = await runToFinal({ kind: 'unity.capture', view: 'game', width: 1024, height: 576 }, {
      ok: true,
      text: 'captured',
      image: { base64: big, mimeType: 'image/png' },
    } as never);

    expect(events.some((e) => e.type === 'bridge-job' && 'image' in e && e.image)).toBe(false);
    expect(typeof outcome === 'string' ? outcome : outcome.text).toBe('captured');
  });

  it('no bridge-job UI event carries a credits field', async () => {
    await runToFinal(SET_TRANSFORM);

    const jobEvents = events.filter((e) => e.type === 'bridge-job');
    expect(jobEvents.length).toBeGreaterThan(0);

    for (const event of jobEvents) {
      expect(event).not.toHaveProperty('credits');
    }
  });
});

describe('not-started settlement (the latch)', () => {
  it('settleDropped twice settles once and writes no ledger row', async () => {
    const pending = runBridgeOperation(SET_TRANSFORM, 'label', ctx());
    const jobId = await waitQueued();
    const ids = cancelGenerationBridgeJobs(GEN);

    expect(ids).toEqual([jobId]);
    await settleDropped(ids, {});
    await settleDropped(ids, {});
    await pending;

    expect((await store.getJob(jobId))?.status).toBe('cancelled');
    expect((await store.getJob(jobId))?.error).toBe('cancelled before it started');
    await expectNothingBilled();
  });

  it('cancel then pickup timeout → the first settler wins, the row stays cancelled by the agent', async () => {
    const pending = runBridgeOperation(SET_TRANSFORM, 'label', ctx());
    const jobId = await waitQueued();

    expect(await jobControl('cancel', jobId, 0, { userId: USER, context: {} })).toBe(
      `Job ${jobId} was cancelled before it started. Nothing ran.`,
    );
    await vi.advanceTimersByTimeAsync(BRIDGE_PICKUP_TIMEOUT_MS + 1);
    await pending;

    const row = await store.getJob(jobId);
    expect(row?.status).toBe('cancelled');
    expect(row?.error).toBe('cancelled by the agent');
    await expectNothingBilled();
  });

  it('a late `started` after the pickup timeout changes nothing', async () => {
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
    await expectNothingBilled();
  });

  it('a duplicate `started` is idempotent — never regresses a row', async () => {
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

    await expectNothingBilled();
  });
});

describe('jobControl', () => {
  it('status formats the row (no credits); another user sees nothing', async () => {
    const { jobId } = await runToFinal(SET_TRANSFORM, { ok: true, text: 'moved' });
    await until(async () => (await store.getJob(jobId))?.status === 'succeeded');

    expect(await jobControl('status', jobId, 0, { userId: USER, context: {} })).toBe(
      `Job ${jobId} (label): succeeded.\nmoved`,
    );
    expect(await jobControl('status', jobId, 0, { userId: 'someone_else', context: {} })).toMatch(
      /No Unity Bridge job/,
    );
  });
});

describe('resolveBridgeTurn (D54 — no project link)', () => {
  const turn = (overrides: { projectId?: string } = {}) =>
    resolveBridgeTurn({
      user: { id: USER },
      projectId: 'projectId' in overrides ? overrides.projectId : PROJECT,
      context: {},
    });

  it('no devices → none', async () => {
    expect(await turn()).toEqual({ state: 'none' });
  });

  it('no project → none, even with a present device', async () => {
    await store.putDevice(device());
    touchDevice(DEVICE, undefined);

    expect(await turn({ projectId: undefined })).toEqual({ state: 'none' });
  });

  it('UNITY_BRIDGE_ENABLED=false → disabled', async () => {
    vi.stubEnv('UNITY_BRIDGE_ENABLED', 'false');
    await store.putDevice(device());
    touchDevice(DEVICE, undefined);

    expect((await turn()).state).toBe('disabled');
  });

  it('devices but none present → offline, naming the most recently seen one', async () => {
    await store.putDevice(device({ id: 'dev_old', name: 'Old', lastSeenAt: '2026-09-28T00:00:00.000Z' }));
    await store.putDevice(device({ id: 'dev_new', name: 'New', lastSeenAt: '2026-09-29T00:00:00.000Z' }));

    const result = await turn();
    expect(result.state).toBe('offline');
    expect(result.device?.id).toBe('dev_new');
  });

  it('a present device → online, with its hello', async () => {
    await store.putDevice(device());
    touchDevice(DEVICE, {
      protocol: 2,
      helperVersion: '1.0.0',
      os: 'darwin',
      projectsDir: 'Unity',
      unityProjects: [],
      scriptsDisabledLocally: false,
    });

    const result = await turn();
    expect(result.state).toBe('online');
    expect(result.device?.id).toBe(DEVICE);
    expect(result.hello?.projectsDir).toBe('Unity');
  });

  it('two present devices → the most recently seen wins', async () => {
    await store.putDevice(device({ id: 'dev_a', name: 'A' }));
    await store.putDevice(device({ id: 'dev_b', name: 'B' }));

    const now = Date.now();
    touchDevice('dev_b', undefined, now - 1000);
    touchDevice('dev_a', undefined, now);

    expect((await turn()).device?.id).toBe('dev_a');

    touchDevice('dev_b', undefined, now + 1);
    expect((await turn()).device?.id).toBe('dev_b');
  });

  it("a revoked device is ignored even when present; another user's device is never offered", async () => {
    await store.putDevice(device({ id: 'dev_revoked', revokedAt: '2026-09-29T01:00:00.000Z' }));
    touchDevice('dev_revoked', undefined);
    await store.putDevice(device({ id: 'dev_theirs', userId: 'someone_else' }));
    touchDevice('dev_theirs', undefined);

    expect(await turn()).toEqual({ state: 'none' });

    await store.putDevice(device({ id: 'dev_mine' }));

    const result = await turn();
    expect(result.state).toBe('offline');
    expect(result.device?.id).toBe('dev_mine');
  });
});
