/**
 * The money-path swallows report (`spec/fail-loud.md` rule 4: `catch` + log is not handling).
 *
 * Three writes on the money path are FORBIDDEN from throwing, for good reasons that are documented
 * where they live: settlement runs inside the proxy's `finally` (an exception there would replace a
 * successful generation's outcome with a spurious error), and a refund is the compensating step for a
 * request that has already failed. None of them can refund or retry their way out — so REPORTING is
 * the only loudness available, and for a year they had only `logger.error`, which is invisible in a
 * deployed environment.
 *
 * Each of these is a case where MONEY MOVED AND THE BOOKS DID NOT FOLLOW IT. The FK-anchor failure is
 * the same defect that would have billed ZERO on every production generation forever; a failed refund
 * leaves the user paying for our failure. If nobody is told, nobody ever finds out.
 *
 * The enumeration, kept complete on purpose — a paid path added without a line here is a swallow
 * nobody will ever hear about:
 *
 *   1. `settleGeneration` — the debit is refused.
 *   2. `settleGeneration` — the FK anchor (`generations` row) cannot be written.
 *   3. `refundGeneration` — the compensating refund does not land.
 *   4. `refundProjectCreate` — the flat creation charge cannot be given back (§4.4a, migration 0015).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DuplicateRefundError, setLedger, type Ledger } from './ledger';
import { setGenerationStore, type GenerationStore } from './generations';
import { refundGeneration, settleGeneration } from './gate';
import { projectCreateNote, refundProjectCreate } from './project-create-service';

const COLLECTOR = 'https://collector.example/ingest';

/** Every alert envelope this test's collector received. */
let shipped: Array<Record<string, any>>;

function brokenLedger(): Ledger {
  return {
    append: async () => {
      throw new Error('ledger unavailable');
    },
    balance: async () => 0,
    list: async () => [],
    listByReason: async () => [],
    listByNote: async () => {
      throw new Error('ledger unavailable');
    },
  } as unknown as Ledger;
}

function ledgerIntegrityAlerts() {
  return shipped.filter((p) => p.kind === 'alert' && p.signal === 'ledger_integrity');
}

beforeEach(() => {
  /* `CREATION_FLAT_CREDITS` is retired (§4.4a) — `getBillingConfig` THROWS when it is set. */
  for (const key of ['BILLING_ENFORCED', 'CREDIT_UNIT_COST_USD', 'CREDIT_MARGIN', 'CREATION_FLAT_CREDITS']) {
    vi.stubEnv(key, undefined as unknown as string);
  }

  vi.stubEnv('MONITORING_WEBHOOK_URL', COLLECTOR);

  shipped = [];
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    shipped.push(JSON.parse(String(init.body)));
    return new Response('ok');
  });

  setLedger(brokenLedger());
  setGenerationStore({
    upsert: async () => undefined,
    list: async () => [],
    hasBilledGeneration: async () => false,
  } as unknown as GenerationStore);
});

afterEach(() => {
  setLedger(undefined);
  setGenerationStore(undefined);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('a swallowed money-path write is reported, never merely logged', () => {
  it('alerts when the generation debit is refused', async () => {
    const settlement = await settleGeneration({
      userId: 'u1',
      generationId: 'gen_1',
      model: 'claude-opus-4-8',
      provider: 'KIE',
      usage: { promptTokens: 40_000, completionTokens: 8000, cacheReadTokens: 0, cacheCreationTokens: 0 },
    });

    // Settlement still never throws — the generation succeeded and must be reported as such.
    expect(settlement).toBeNull();

    await vi.waitFor(() => expect(ledgerIntegrityAlerts()).toHaveLength(1));
    expect(ledgerIntegrityAlerts()[0]).toMatchObject({ severity: 'critical', scope: 'settle-generation' });
  });

  it("alerts when the generation's FK anchor cannot be written", async () => {
    setGenerationStore({
      upsert: async () => {
        throw new Error('generations table unreachable');
      },
      list: async () => [],
    } as unknown as GenerationStore);

    await settleGeneration({
      userId: 'u1',
      generationId: 'gen_2',
      model: 'claude-opus-4-8',
      provider: 'KIE',
      usage: { promptTokens: 40_000, completionTokens: 8000, cacheReadTokens: 0, cacheCreationTokens: 0 },
    });

    await vi.waitFor(() => expect(ledgerIntegrityAlerts().length).toBeGreaterThan(0));
    expect(ledgerIntegrityAlerts()[0]).toMatchObject({ severity: 'critical' });
    expect(String(ledgerIntegrityAlerts()[0].detail)).toMatch(/bill ZERO/);
  });

  it('alerts when a refund does not land — the user is still charged for our failure', async () => {
    await refundGeneration('u1', 'gen_3', 42, 'Automatic refund — the generation failed');

    await vi.waitFor(() => expect(ledgerIntegrityAlerts()).toHaveLength(1));
    expect(ledgerIntegrityAlerts()[0]).toMatchObject({ severity: 'critical', scope: 'refund-generation' });
  });

  /*
   * 4. The flat New Project charge (§4.4a). The project is GONE by the time this runs, so there is no
   * retry and no second chance: if the refund does not land, the platform has kept money for a project
   * it never delivered, and the only trace is a ledger the user has to go and read. Best-effort by
   * design — a ledger outage must not make a project undeletable — which is exactly why it must be
   * loud.
   */
  it('alerts when the project-creation refund does not land', async () => {
    await refundProjectCreate({ userId: 'u1', projectId: 'prj_1' });

    await vi.waitFor(() => expect(ledgerIntegrityAlerts()).toHaveLength(1));
    expect(ledgerIntegrityAlerts()[0]).toMatchObject({ severity: 'critical', scope: 'refund-project-create' });
    expect(String(ledgerIntegrityAlerts()[0].detail)).toContain('prj_1');
  });

  /*
   * 🔴 CONTROL — `DuplicateRefundError` is the SUCCESS path, not a failure. It means migration 0015's
   * partial unique index caught a concurrent delete and the user already HAS their credits back.
   * Paging an operator here would train them to ignore the signal that matters four lines above.
   */
  it('does NOT alert when the index refuses a refund that was already paid', async () => {
    const note = projectCreateNote('prj_2');

    setLedger({
      ...brokenLedger(),
      listByNote: async () => [{ id: 'e1', userId: 'u1', delta: -150, reason: 'project_create', note }],
      append: async () => {
        throw new DuplicateRefundError(note);
      },
    } as unknown as Ledger);

    expect(await refundProjectCreate({ userId: 'u1', projectId: 'prj_2' })).toBe(0);

    expect(ledgerIntegrityAlerts()).toHaveLength(0);
  });

  /*
   * The control the `no-server-storage.spec.ts` lesson demands: a scanner (or a collector) that
   * silently matches nothing reports a clean bill of health forever. Prove the wiring can see traffic.
   */
  it('CONTROL — a healthy settlement ships no integrity alert', async () => {
    setLedger({
      append: async () => ({ id: 'e1', balanceAfter: 500 }),
      balance: async () => 500,
      list: async () => [],
      listByReason: async () => [],
    } as unknown as Ledger);

    await settleGeneration({
      userId: 'u1',
      generationId: 'gen_4',
      model: 'claude-opus-4-8',
      provider: 'KIE',
      usage: { promptTokens: 40_000, completionTokens: 8000, cacheReadTokens: 0, cacheCreationTokens: 0 },
    });

    expect(ledgerIntegrityAlerts()).toHaveLength(0);
  });
});
