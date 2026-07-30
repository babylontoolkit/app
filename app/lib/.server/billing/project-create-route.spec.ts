/**
 * The flat New Project charge, end to end through the two routes that take it and give it back
 * (§4.4a, §4.6, migration 0015, `spec/fail-loud.md`).
 *
 * `project-create.spec.ts` pins the pure decision and the config; this file pins the WIRING, which is
 * where every failure of this feature is silent and costs money in one direction or the other:
 *
 * - **A refusal that leaves a row behind** is a free project — nothing downstream ever notices an
 *   unpaid project, and the user cannot tell. So the refusal is asserted as a PROPERTY of the whole
 *   system after the call ("zero project rows, zero ledger rows"), never as a status code alone.
 * - **A debit that lands without the project** is the same bug facing the other way: the user paid for
 *   nothing. The route's rollback path (`debitProjectCreate` throwing because a concurrent debit drained
 *   the balance between the quote and the debit) is driven here with a ledger that refuses.
 * - **A refund that does not happen** is invisible: the DELETE still returns `{ok: true}`, the project
 *   still disappears, and the only trace is a ledger the user has to go and read. Removing the
 *   `refundProjectCreate` call from the delete route fails the tests below — that is the mutation this
 *   file exists to catch.
 * - **A refund that happens TWICE** is a credit faucet: delete-and-recreate in a loop and get paid.
 *   Idempotency here is structural (`requireOwnedProject` 404s once the row is gone), so the second
 *   delete is driven for real rather than assumed.
 *
 * ⚠️ The `oauth.spec.ts` trap: `env()` falls back to `process.env` and vitest loads `.env.local`, so
 * every assertion about the price or about enforcement scrubs the WHOLE precedence chain first —
 * `.env.example` actively tells operators to set `PROJECT_CREATE_CREDITS`, so a developer who followed
 * it would otherwise fail these locally with CI green.
 *
 * Route specs live BESIDE the code they exercise, never in `app/routes/` — Remix compiles a spec file
 * there as a route and every request 500s.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FsObjectStore } from '~/lib/.server/storage/store';
import { setObjectStore } from '~/lib/.server/storage';
import { FsChatIndex, setChatIndex } from '~/lib/.server/projects/chat-index';
import { FsProjectStore, setProjectStore } from '~/lib/.server/projects/store';
import type { ProjectStore } from '~/lib/.server/projects/types';
import { FsLedger, setLedger, type Ledger } from './ledger';
import { FsGenerationStore, setGenerationStore } from './generations';
import { projectCreateNote } from './project-create-service';

const USER = { id: 'user-1', email: 'a@example.com', emailVerified: true } as const;

vi.mock('~/lib/.server/supabase/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  requireVerifiedUser: async () => USER,
  requireUser: async () => USER,
}));

/**
 * Mocked, not driven: `~/lib/.server/sandbox/service` imports `@codesandbox/sdk` at module scope, so an
 * unmocked route import drags the vendor SDK (and its API key requirement) into a test about money.
 */
vi.mock('~/lib/.server/sandbox/service', () => ({
  deleteSandbox: async () => undefined,
}));

/**
 * The full precedence chain that can reach the creation price and the enforcement flag. Scrubbing only
 * the variable under test is the failure `billing.spec.ts` records twice.
 */
const SCRUBBED_ENV = [
  'PROJECT_CREATE_CREDITS',
  'BILLING_ENFORCED',

  /* The retired predecessor — `getBillingConfig` THROWS when it is set (§4.4a). */
  'CREATION_FLAT_CREDITS',
] as const;

const PRICE = 100;

let tmp: string;
let ledger: FsLedger;
let projects: FsProjectStore;
let generations: FsGenerationStore;

/** Enforced billing at the default price — the state in which the charge is real. */
const enforced = () => {
  vi.stubEnv('BILLING_ENFORCED', 'true');
  vi.stubEnv('PROJECT_CREATE_CREDITS', String(PRICE));
};

const grant = async (credits: number) => {
  await ledger.append({ userId: USER.id, delta: credits, reason: 'grant' });
};

const createProject = async (name = 'Kart Racer') => {
  const { action } = await import('~/routes/api.projects');

  return action({
    request: new Request('https://app.example.com/api/projects', {
      method: 'POST',
      body: JSON.stringify({ name, templateId: 'racing' }),
    }),
    params: {},
    context: {},
  } as never);
};

const deleteProject = async (projectId: string) => {
  const { action } = await import('~/routes/api.projects.$projectId');

  return action({
    request: new Request('https://app.example.com/api/projects/p', { method: 'DELETE' }),
    params: { projectId },
    context: {},
  } as never);
};

const rows = async () => ledger.list(USER.id, 500);
const rowsWithReason = async (reason: string) => (await rows()).filter((r) => r.reason === reason);

beforeEach(async () => {
  for (const key of SCRUBBED_ENV) {
    vi.stubEnv(key, undefined as unknown as string);
  }

  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'project-create-route-'));

  ledger = new FsLedger(path.join(tmp, 'ledger'));
  setLedger(ledger);

  projects = new FsProjectStore(path.join(tmp, 'projects'));
  setProjectStore(projects);

  generations = new FsGenerationStore(path.join(tmp, 'generations'));
  setGenerationStore(generations);

  /*
   * Both storage seams, or the DELETE path writes into the developer's real `.data/`
   * (`message-store.spec.ts` records exactly that footgun).
   */
  setObjectStore(new FsObjectStore(path.join(tmp, 'objects')));
  setChatIndex(new FsChatIndex(path.join(tmp, 'index')));
});

afterEach(async () => {
  setLedger(undefined);
  setGenerationStore(undefined);
  setProjectStore(undefined);
  setObjectStore(undefined);
  setChatIndex(undefined);
  await fs.rm(tmp, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe('POST /api/projects — refused because the balance cannot cover the price', () => {
  beforeEach(async () => {
    enforced();
    await grant(PRICE - 1); // One credit short: the boundary is inclusive, so this is the first refusal.
  });

  it('402s and NAMES the price, so the user knows how many credits to buy', async () => {
    const response = await createProject();

    expect(response.status).toBe(402);

    const body = (await response.json()) as { message: string; balance: number; isRetryable: boolean };

    expect(body.message).toContain(String(PRICE));
    expect(body.message).toContain(String(PRICE - 1));

    // Retrying with the same balance would refuse identically — telling the client otherwise is a loop.
    expect(body.isRetryable).toBe(false);
    expect(body.balance).toBe(PRICE - 1);
  });

  /*
   * 🔴 The property that matters. A 402 with a project row behind it is a free project: nothing
   * downstream ever notices an unpaid project, and the user cannot see one either.
   */
  it('writes ZERO project rows', async () => {
    await createProject();

    expect(await projects.listByUser(USER.id)).toEqual([]);
  });

  /*
   * And zero ledger rows: a refusal is not a transaction. A zero-value or half-taken row here would
   * make the audit trail claim a charge that never happened.
   */
  it('writes ZERO ledger rows beyond the grant that was already there', async () => {
    await createProject();

    expect(await rowsWithReason('project_create')).toEqual([]);
    expect(await rows()).toHaveLength(1);
    expect(await ledger.balance(USER.id)).toBe(PRICE - 1);
  });
});

describe('POST /api/projects — charged', () => {
  beforeEach(async () => {
    enforced();
    await grant(1_000);
  });

  it('creates the project and takes exactly one project_create debit for the configured price', async () => {
    const response = await createProject();

    expect(response.status).toBe(201);

    const { project } = (await response.json()) as { project: { id: string }; balance: number };

    expect(await projects.get(project.id)).not.toBeNull();

    const debits = await rowsWithReason('project_create');

    expect(debits).toHaveLength(1);
    expect(debits[0].delta).toBe(-PRICE);
  });

  /*
   * `balanceAfter` is written by the ledger, not computed by the caller — deriving it in TypeScript is
   * the race migration 0003 exists to prevent. Assert the row agrees with the DERIVED balance.
   */
  it('records a balanceAfter that matches the derived balance, and hands it back on the response', async () => {
    const response = await createProject();
    const body = (await response.json()) as { balance: number };

    const debit = (await rowsWithReason('project_create'))[0];

    expect(debit.balanceAfter).toBe(1_000 - PRICE);
    expect(await ledger.balance(USER.id)).toBe(debit.balanceAfter);

    // A settled charge the UI cannot see reads to the user as a leak (the enhancer's drift defect).
    expect(body.balance).toBe(debit.balanceAfter);
  });

  /** The note is the ONLY link between the charge and the project — the refund path matches on it. */
  it('names the project in the debit note, which is what makes the charge attributable', async () => {
    const response = await createProject();
    const { project } = (await response.json()) as { project: { id: string } };

    expect((await rowsWithReason('project_create'))[0].note).toBe(projectCreateNote(project.id));
  });

  /** A balance EXACTLY at the price buys a project — the boundary is inclusive, and it lands at zero. */
  it('allows a balance exactly equal to the price', async () => {
    // Spend down to exactly the price first, so this user has precisely enough and no more.
    await ledger.append({ userId: USER.id, delta: -(1_000 - PRICE), reason: 'adjustment' });

    expect((await createProject()).status).toBe(201);
    expect(await ledger.balance(USER.id)).toBe(0);
  });
});

describe('POST /api/projects — free (PROJECT_CREATE_CREDITS=0)', () => {
  /*
   * `0` is the operator's real "creation is free" switch, not "unset". It must free EVERYONE, including
   * a user with nothing — and it must write NO row: a zero-value entry is noise in an audit, not
   * evidence.
   */
  it('creates the project and writes no ledger row at all, even on a zero balance', async () => {
    vi.stubEnv('BILLING_ENFORCED', 'true');
    vi.stubEnv('PROJECT_CREATE_CREDITS', '0');

    const response = await createProject();

    expect(response.status).toBe(201);
    expect(await projects.listByUser(USER.id)).toHaveLength(1);
    expect(await rows()).toEqual([]);
  });

  /** Omitted, not zero: reporting `balance: 0` would wipe the displayed number on every free creation. */
  it('omits `balance` from the response when nothing was charged', async () => {
    vi.stubEnv('BILLING_ENFORCED', 'true');
    vi.stubEnv('PROJECT_CREATE_CREDITS', '0');

    const body = (await (await createProject()).json()) as Record<string, unknown>;

    expect('balance' in body).toBe(false);
  });

  /** Unmetered mode: the same free path, reached by the other switch. */
  it('is free when billing is not enforced', async () => {
    vi.stubEnv('BILLING_ENFORCED', 'false');
    vi.stubEnv('PROJECT_CREATE_CREDITS', String(PRICE));

    expect((await createProject()).status).toBe(201);
    expect(await rows()).toEqual([]);
  });
});

describe('POST /api/projects — the ledger refuses AFTER the row exists', () => {
  /*
   * The window the two-step ordering opens: a concurrent debit drains the balance between the quote and
   * the debit, and `project_create` may not overdraw, so the ledger throws. An unpaid project is worse
   * than a refused one (nothing downstream will ever notice it), so the row must be rolled back.
   */
  it('rolls the project row back and 402s retryably', async () => {
    enforced();
    await grant(1_000);

    const refusing: Ledger = {
      ...ledger,
      balance: (userId: string) => ledger.balance(userId),
      list: (userId: string, limit?: number) => ledger.list(userId, limit),
      append: async (entry) => {
        if (entry.reason === 'project_create') {
          throw new Error('Refusing to append project_create: it would drive the balance negative.');
        }

        return ledger.append(entry);
      },
    } as Ledger;

    setLedger(refusing);

    const response = await createProject();

    expect(response.status).toBe(402);
    expect(((await response.json()) as { isRetryable: boolean }).isRetryable).toBe(true);

    // The row is GONE — not left unpaid.
    expect(await projects.listByUser(USER.id)).toEqual([]);
  });
});

describe('DELETE /api/projects/:id — refunding a project that never delivered', () => {
  beforeEach(async () => {
    enforced();
    await grant(1_000);
  });

  const createAndGetId = async () => {
    const { project } = (await (await createProject()).json()) as { project: { id: string } };
    return project.id;
  };

  /*
   * 🔴 The mutation this file exists for: delete `refundProjectCreate` from the delete route and this
   * fails. Nothing else would — the DELETE still 200s and the project still disappears.
   */
  it('refunds the exact charge, exactly once, restoring the balance', async () => {
    const id = await createAndGetId();

    expect(await ledger.balance(USER.id)).toBe(1_000 - PRICE);

    expect((await deleteProject(id)).status).toBe(200);

    const refunds = await rowsWithReason('refund');

    expect(refunds).toHaveLength(1);
    expect(refunds[0].delta).toBe(PRICE);
    expect(refunds[0].note).toBe(projectCreateNote(id));
    expect(await ledger.balance(USER.id)).toBe(1_000);
  });

  /*
   * The faucet: a second refund would let delete-and-recreate pay the user. Idempotency is structural
   * (`requireOwnedProject` 404s once the row is gone), so drive the second delete for real rather than
   * trusting the argument.
   */
  it('cannot double-refund — a second delete 404s and moves no money', async () => {
    const id = await createAndGetId();

    await deleteProject(id);

    const balanceAfterFirst = await ledger.balance(USER.id);

    expect((await deleteProject(id)).status).toBe(404);

    expect(await rowsWithReason('refund')).toHaveLength(1);
    expect(await ledger.balance(USER.id)).toBe(balanceAfterFirst);
  });

  /*
   * A generation the user was CHARGED for is the observable definition of "creation delivered". Deleting
   * a game you built is not a reason to be given the creation charge back.
   */
  it('refunds NOTHING when the project had a billed generation', async () => {
    const id = await createAndGetId();

    await generations.upsert({
      id: 'gen-1',
      userId: USER.id,
      projectId: id,
      model: 'claude-opus-5',
      creditsCharged: 42,
    });

    await deleteProject(id);

    expect(await rowsWithReason('refund')).toEqual([]);
    expect(await ledger.balance(USER.id)).toBe(1_000 - PRICE);
  });

  /*
   * A FAILED generation was auto-refunded (§4.6), so it bought nothing — it must not keep the creation
   * charge alive. This is the case a "has a generations row" check would get wrong.
   */
  it('still refunds when the only generation charged zero (a failed/refunded attempt)', async () => {
    const id = await createAndGetId();

    await generations.upsert({
      id: 'gen-zero',
      userId: USER.id,
      projectId: id,
      model: 'claude-opus-5',
      creditsCharged: 0,
      status: 'failed',
    });

    await deleteProject(id);

    expect(await rowsWithReason('refund')).toHaveLength(1);
    expect(await ledger.balance(USER.id)).toBe(1_000);
  });

  /** Another project's billed generation is not this project's delivery. */
  it('does not let a sibling project’s billed generation block the refund', async () => {
    const id = await createAndGetId();
    const other = await createAndGetId();

    await generations.upsert({
      id: 'gen-other',
      userId: USER.id,
      projectId: other,
      model: 'claude-opus-5',
      creditsCharged: 99,
    });

    await deleteProject(id);

    const refunds = await rowsWithReason('refund');

    expect(refunds).toHaveLength(1);
    expect(refunds[0].note).toBe(projectCreateNote(id));
  });

  /** Nothing was charged, so nothing comes back — and no zero-value row is written pretending it did. */
  it('writes no refund row when creation was free', async () => {
    vi.stubEnv('PROJECT_CREATE_CREDITS', '0');

    const id = await createAndGetId();

    await deleteProject(id);

    expect(await rows()).toHaveLength(1); // the grant only
  });

  /**
   * Best-effort, but never at the cost of the delete: the user pressed Delete. A ledger outage must not
   * make a project undeletable.
   */
  it('still deletes the project when the refund cannot be written', async () => {
    const id = await createAndGetId();

    setLedger({
      ...ledger,
      balance: (userId: string) => ledger.balance(userId),
      list: async () => {
        throw new Error('ledger is down');
      },
      listByNote: async () => {
        throw new Error('ledger is down');
      },
      append: async () => {
        throw new Error('ledger is down');
      },
    } as unknown as Ledger);

    expect((await deleteProject(id)).status).toBe(200);
    expect(await projects.get(id)).toBeNull();
  });

  /**
   * 🔴 THE ORDERING. `store.delete` runs FIRST, `refundProjectCreate` second — and reverting those two
   * lines is a credit faucet that every other test in this file passes happily.
   *
   * The sequence is ordinary, not exotic: the delete fails (a DB blip), the dashboard toasts "Failed to
   * delete project" and LEAVES THE CARD IN PLACE, so the user's next action is to click Delete again.
   * With the refund written first, click one pays them back while keeping the project — a working game
   * they no longer paid for — and click two 404s or (thanks to the index) quietly succeeds, leaving the
   * books saying the creation was refunded for a project that still exists.
   *
   * The assertion that actually catches the swap is the MIDDLE one: after a FAILED delete, no money may
   * have moved, because the project is still there. The totals afterwards pin the idempotency half.
   */
  it('moves NO money when the delete fails, and refunds exactly once on the retry', async () => {
    const id = await createAndGetId();

    expect(await ledger.balance(USER.id)).toBe(1_000 - PRICE);

    let failNext = true;

    setProjectStore({
      ...projects,
      get: (projectId: string) => projects.get(projectId),
      listByUser: (userId: string) => projects.listByUser(userId),
      create: (project: never) => projects.create(project),
      update: (projectId: string, patch: never) => projects.update(projectId, patch),
      delete: async (projectId: string) => {
        if (failNext) {
          failNext = false;
          throw new Error('project store is down');
        }

        return projects.delete(projectId);
      },
    } as unknown as ProjectStore);

    // Click one: the delete blows up, so the project survives...
    const failed = await deleteProject(id);

    expect(failed.ok).toBe(false);
    expect(await projects.get(id)).not.toBeNull();

    // ...and therefore NOTHING may have been given back. This is the assertion the swap fails.
    expect(await rowsWithReason('refund')).toEqual([]);
    expect(await ledger.balance(USER.id)).toBe(1_000 - PRICE);

    // Click two: the delete lands, and now — and only now — the money comes back. Once.
    expect((await deleteProject(id)).status).toBe(200);

    expect(await rowsWithReason('refund')).toHaveLength(1);
    expect(await ledger.balance(USER.id)).toBe(1_000);
  });

  /**
   * Two CONCURRENT deletes — the hole the ordering canNOT close, and the reason migration 0015 adds a
   * partial unique index rather than trusting the read-then-write check in `refundProjectCreate`.
   *
   * Both requests pass `requireOwnedProject` before either one deletes the row, so both reach the
   * refund and both read "not refunded yet". Exactly one row may land. The gate below makes the
   * interleaving deterministic instead of hoping the event loop reproduces it.
   */
  it('refunds ONCE when two deletes race past the ownership check', async () => {
    const id = await createAndGetId();

    let checked = 0;
    let releaseBoth: () => void;
    const bothChecked = new Promise<void>((resolve) => {
      releaseBoth = resolve;
    });

    setProjectStore({
      ...projects,
      get: async (projectId: string) => {
        const project = await projects.get(projectId);

        if (++checked >= 2) {
          releaseBoth();
        }

        return project;
      },
      listByUser: (userId: string) => projects.listByUser(userId),
      create: (project: never) => projects.create(project),
      update: (projectId: string, patch: never) => projects.update(projectId, patch),
      delete: async (projectId: string) => {
        // Hold until BOTH requests have been told they own this project — the real race, made reliable.
        await bothChecked;
        return projects.delete(projectId);
      },
    } as unknown as ProjectStore);

    const [a, b] = await Promise.all([deleteProject(id), deleteProject(id)]);

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(await projects.get(id)).toBeNull();

    // One project, one creation charge, one refund — never two.
    expect(await rowsWithReason('refund')).toHaveLength(1);
    expect(await ledger.balance(USER.id)).toBe(1_000);
  });
});

/**
 * `hasBilledGeneration` is the whole definition of "this project delivered something", and it is read
 * once, on a delete, to decide whether money goes back. Both halves of the predicate are load-bearing:
 * drop the project match and every user's first billed generation blocks every refund; drop the
 * `> 0` and a failed (already auto-refunded) generation silently keeps the creation charge.
 */
describe('FsGenerationStore.hasBilledGeneration', () => {
  let store: FsGenerationStore;

  beforeEach(() => {
    store = new FsGenerationStore(path.join(tmp, 'has-billed'));
  });

  it('is false when the store has never been written to', async () => {
    expect(await store.hasBilledGeneration('prj_1')).toBe(false);
  });

  it('is true for a generation on this project that charged credits', async () => {
    await store.upsert({ id: 'g1', userId: USER.id, model: 'm', projectId: 'prj_1', creditsCharged: 10 });

    expect(await store.hasBilledGeneration('prj_1')).toBe(true);
  });

  it('is false for a generation on this project that charged NOTHING', async () => {
    await store.upsert({
      id: 'g1',
      userId: USER.id,
      model: 'm',
      projectId: 'prj_1',
      creditsCharged: 0,
      status: 'failed',
    });

    expect(await store.hasBilledGeneration('prj_1')).toBe(false);
  });

  /** A row with no `creditsCharged` at all (an anchored, never-settled generation) is not delivery. */
  it('is false for a generation with no creditsCharged field', async () => {
    await store.upsert({ id: 'g1', userId: USER.id, model: 'm', projectId: 'prj_1', status: 'running' });

    expect(await store.hasBilledGeneration('prj_1')).toBe(false);
  });

  it('is false for a BILLED generation belonging to a DIFFERENT project', async () => {
    await store.upsert({ id: 'g1', userId: USER.id, model: 'm', projectId: 'prj_other', creditsCharged: 10 });

    expect(await store.hasBilledGeneration('prj_1')).toBe(false);
  });

  /** Both halves together: a mixed store must answer per project, not "somebody was billed once". */
  it('answers per project across a mixed store', async () => {
    await store.upsert({ id: 'g1', userId: USER.id, model: 'm', projectId: 'prj_a', creditsCharged: 0 });
    await store.upsert({ id: 'g2', userId: USER.id, model: 'm', projectId: 'prj_b', creditsCharged: 7 });
    await store.upsert({ id: 'g3', userId: USER.id, model: 'm', projectId: 'prj_a', creditsCharged: 3 });

    expect(await store.hasBilledGeneration('prj_a')).toBe(true);
    expect(await store.hasBilledGeneration('prj_b')).toBe(true);
    expect(await store.hasBilledGeneration('prj_c')).toBe(false);
  });
});

/**
 * A refund the store cannot answer for must not be paid out. The Supabase implementation's
 * fail-CLOSED contract is driven in `has-billed-generation-supabase.spec.ts` (it needs the Supabase
 * client mocked, which this file's route imports must not have).
 */
