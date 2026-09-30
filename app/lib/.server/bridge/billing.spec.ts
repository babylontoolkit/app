/**
 * Unity Bridge billing (D11, D13, spec/billing.md).
 *
 * Prices are config, sanitised like `PROJECT_CREATE_CREDITS`: a negative or non-numeric value falls back
 * to the default (obeying a negative would CREDIT the user), `0` is free, and a fraction is floored.
 *
 * The refund is written exactly once: the note `bridge:<jobId>` is single-use in BOTH backends
 * (migration 0025's partial unique index, mirrored by `FsLedger` through `isSingleRefundNote`), and a
 * second append is the success path — logged, never alerted.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DuplicateRefundError, FsLedger, setLedger, type Ledger } from '~/lib/.server/billing/ledger';
import { bridgePrices, bridgeRefundNote, refundBridgeJob } from './billing';

const KEYS = ['BRIDGE_COMMAND_CREDITS', 'BRIDGE_SCRIPT_CREDITS', 'BRIDGE_JOB_CREDITS'] as const;
const COLLECTOR = 'https://collector.example/ingest';
const USER = 'user_1';

let shipped: Array<Record<string, any>>;

const integrityAlerts = () => shipped.filter((p) => p.kind === 'alert' && p.signal === 'ledger_integrity');

beforeEach(() => {
  for (const key of [...KEYS, 'BILLING_ENFORCED', 'CREDIT_UNIT_COST_USD', 'CREDIT_MARGIN', 'CREATION_FLAT_CREDITS']) {
    vi.stubEnv(key, undefined as unknown as string);
  }

  vi.stubEnv('MONITORING_WEBHOOK_URL', COLLECTOR);
  shipped = [];
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    shipped.push(JSON.parse(String(init.body)));
    return new Response('ok');
  });
});

afterEach(() => {
  setLedger(undefined);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('bridgePrices', () => {
  it('defaults to 1 / 2 / 4', () => {
    expect(bridgePrices({})).toEqual({ command: 1, script: 2, job: 4 });
  });

  it('a negative price falls back to the default', () => {
    vi.stubEnv('BRIDGE_COMMAND_CREDITS', '-3');
    expect(bridgePrices({}).command).toBe(1);
  });

  it('0 makes the class free', () => {
    vi.stubEnv('BRIDGE_COMMAND_CREDITS', '0');
    expect(bridgePrices({}).command).toBe(0);
  });

  it('a fraction is floored', () => {
    vi.stubEnv('BRIDGE_COMMAND_CREDITS', '2.7');
    expect(bridgePrices({}).command).toBe(2);
  });

  it('a non-numeric value falls back to the default', () => {
    vi.stubEnv('BRIDGE_JOB_CREDITS', 'lots');
    expect(bridgePrices({}).job).toBe(4);
  });

  it('the refund note is exactly bridge:<jobId> (the partial unique index keys on it)', () => {
    expect(bridgeRefundNote('brg_x')).toBe('bridge:brg_x');
  });
});

describe('refundBridgeJob — exactly once, through the ledger (D13 latch 2)', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-billing-'));
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('FsLedger refuses a second refund for the same job with DuplicateRefundError', async () => {
    const ledger = new FsLedger(tmp);

    await ledger.append({ userId: USER, delta: 1, reason: 'refund', note: 'bridge:brg_x' });
    await expect(
      ledger.append({ userId: USER, delta: 1, reason: 'refund', note: 'bridge:brg_x' }),
    ).rejects.toBeInstanceOf(DuplicateRefundError);
  });

  it('a second refundBridgeJob for the same job lands no second row and raises no alert', async () => {
    const ledger = new FsLedger(tmp);
    setLedger(ledger);
    await ledger.append({ userId: USER, delta: 10, reason: 'grant' });

    const info = vi.spyOn(console, 'log');

    await refundBridgeJob({ jobId: 'brg_x', userId: USER, credits: 2, reason: 'not picked up', context: {} });
    await refundBridgeJob({ jobId: 'brg_x', userId: USER, credits: 2, reason: 'cancelled', context: {} });

    const refunds = (await ledger.list(USER, 100)).filter((row) => row.reason === 'refund');
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatchObject({ delta: 2, note: 'bridge:brg_x', generationId: 'brg_x' });
    expect(await ledger.balance(USER)).toBe(12);

    expect(integrityAlerts()).toHaveLength(0);
    expect(info.mock.calls.some((call) => call.join(' ').includes('bridge refund for brg_x already recorded'))).toBe(
      true,
    );
    info.mockRestore();
  });

  it('CONTROL — a refund that genuinely fails DOES alert', async () => {
    setLedger({
      append: async () => {
        throw new Error('ledger unavailable');
      },
    } as unknown as Ledger);

    await refundBridgeJob({ jobId: 'brg_y', userId: USER, credits: 2, reason: 'not picked up', context: {} });

    expect(integrityAlerts()).toHaveLength(1);
  });
});
