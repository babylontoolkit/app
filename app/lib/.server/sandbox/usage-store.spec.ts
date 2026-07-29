/**
 * Sandbox lifecycle marks: the store, and the service that emits them (plan T12, SPEC §4.6, §4.10).
 *
 * Two properties are pinned here, and both fail silently:
 *
 *   - **Bookkeeping can never fail the work.** Every mark is written on a path a user is waiting on —
 *     a project opening, a VM being reaped. A store outage that failed `createSandboxForProject` would
 *     turn a missing row in one admin report into a broken product.
 *   - **A close mark is written only when the VM actually stopped.** A failed hibernate leaves the VM
 *     RUNNING and billing; recording the close anyway would end the interval in the report while the
 *     meter kept turning, i.e. under-state cost at exactly the moment the cost is real.
 *
 * ⚠️ The FS store's real default path is `platformDataDir()/sandbox-usage/marks.jsonl` — the repo's own
 * `.data/`. Every test here passes an explicit temp file (this codebase has already deposited ~200 real
 * rows in a developer's `.data/` by stubbing only half a store seam); nothing below may write there.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FsSandboxUsageStore,
  recordSandboxMark,
  MARK_WRITE_DEADLINE_MS,
  setSandboxUsageStore,
  type SandboxMark,
  type SandboxUsageStore,
} from './usage-store';

/*
 * The provider. Mocked wholesale so the service's own code runs (that is what is under test) while no
 * network call is possible — a real one from a test is a hard failure here, and it would cost a VM.
 */
const sandboxes = vi.hoisted(() => ({
  create: vi.fn(),
  resume: vi.fn(),
  hibernate: vi.fn(),
  shutdown: vi.fn(),
  delete: vi.fn(),
}));

vi.mock('@codesandbox/sdk', () => ({
  CodeSandbox: class {
    sandboxes = sandboxes;
  },
  VMTier: { All: [{ name: 'Pico' }], Pico: { name: 'Pico' } },
}));

let tmp: string;

/** A store that records what it was asked to write, and can be told to fail. */
function recordingStore() {
  const marks: SandboxMark[] = [];
  let fail = false;

  const store: SandboxUsageStore = {
    async append(mark) {
      if (fail) {
        throw new Error('usage store is down');
      }

      marks.push(mark);
    },
    async list() {
      return [...marks].reverse();
    },
  };

  return { store, marks, breakIt: () => (fail = true) };
}

beforeEach(async () => {
  vi.stubEnv('CODESANDBOX_API_KEY', 'csb_test_key');

  for (const spy of Object.values(sandboxes)) {
    spy.mockReset();
  }

  sandboxes.create.mockResolvedValue({ id: 'sb-new', bootupType: 'FORK' });
  sandboxes.resume.mockResolvedValue({ id: 'sb-1', bootupType: 'RESUME', updateTier: vi.fn() });
  sandboxes.hibernate.mockResolvedValue(undefined);
  sandboxes.shutdown.mockResolvedValue(undefined);
  sandboxes.delete.mockResolvedValue(undefined);

  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sandbox-usage-'));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  setSandboxUsageStore(undefined);
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('FsSandboxUsageStore', () => {
  const file = () => path.join(tmp, 'marks.jsonl');

  it('round-trips appended marks, newest first', async () => {
    const store = new FsSandboxUsageStore(file());

    await store.append({ event: 'create', sandboxId: 'sb-1', userId: 'u1', projectId: 'p1', at: 1000 });
    await store.append({ event: 'hibernate', sandboxId: 'sb-1', userId: 'u1', projectId: 'p1', at: 3000 });
    await store.append({ event: 'resume', sandboxId: 'sb-2', at: 2000 });

    const marks = await store.list();

    expect(marks.map((m) => m.at)).toEqual([3000, 2000, 1000]);
    expect(marks[2]).toEqual({ event: 'create', sandboxId: 'sb-1', userId: 'u1', projectId: 'p1', at: 1000 });
  });

  it('returns an empty list when nothing has ever run — that is an answer, not an error', async () => {
    expect(await new FsSandboxUsageStore(path.join(tmp, 'never-written.jsonl')).list()).toEqual([]);
  });

  it('skips a torn line rather than failing the whole listing', async () => {
    /*
     * A half-written tail is the ordinary state of an append-only file that was interrupted. Throwing
     * on it would take the admin dashboard down over the least important row in the stream.
     */
    const store = new FsSandboxUsageStore(file());
    await store.append({ event: 'create', sandboxId: 'sb-1', at: 1000 });
    await fs.appendFile(file(), '{"event":"hibernate","sandboxId":"sb-1"\n', 'utf8');
    await store.append({ event: 'hibernate', sandboxId: 'sb-1', at: 2000 });

    const marks = await store.list();

    expect(marks.map((m) => m.event)).toEqual(['hibernate', 'create']);
    expect(marks.map((m) => m.at)).toEqual([2000, 1000]);
  });

  it('honours the limit, keeping the NEWEST marks', async () => {
    const store = new FsSandboxUsageStore(file());

    for (let i = 0; i < 5; i++) {
      await store.append({ event: 'create', sandboxId: `sb-${i}`, at: 1000 + i });
    }

    expect((await store.list(2)).map((m) => m.at)).toEqual([1004, 1003]);
  });
});

describe('recordSandboxMark', () => {
  it('never throws when the store is down — a missing row costs one report, nothing else', async () => {
    const { store, breakIt } = recordingStore();
    breakIt();
    setSandboxUsageStore(store);

    await expect(recordSandboxMark({ event: 'create', sandboxId: 'sb-1', at: 1 })).resolves.toBeUndefined();
  });

  /*
   * 🔴 "Cannot throw" is not "cannot block", and only the second one is about the user.
   *
   * A store that HANGS — a stalled Supabase connection, not a refused one — would hold every project
   * open and every project delete for as long as it stayed stuck, with the catch above never firing.
   * The deadline is the only thing standing between that and an indefinite stall on a path a person is
   * watching, and without this test deleting the `Promise.race` breaks nothing.
   */
  it('abandons the WAIT when the store hangs, and says so', async () => {
    vi.useFakeTimers();

    try {
      // `createScopedLogger` writes through `console.log`, not `console.warn`.
      const logged = vi.spyOn(console, 'log').mockImplementation(() => undefined);

      // Never settles: the failure mode a rejection-based test cannot reach.
      const neverSettles = () => new Promise<void>(() => undefined);
      setSandboxUsageStore({ append: neverSettles, list: async () => [] });

      let settled = false;
      const write = recordSandboxMark({ event: 'create', sandboxId: 'sb-hang', at: 1 }).then(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(MARK_WRITE_DEADLINE_MS - 1);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      await write;

      expect(settled).toBe(true);

      // A hang that resolves silently is the one failure this module could not see. It must be reported.
      expect(JSON.stringify(logged.mock.calls)).toContain('sb-hang');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the service emits marks best-effort (service.ts)', () => {
  it('records a create — with the project id even when the caller supplied none', async () => {
    /*
     * `createSandboxForProject` knows the project whatever the attribution says, so a create is never
     * unattributed by project. Losing that would leave the report unable to say which game an hour
     * belongs to, on the one event where the answer is certain.
     */
    const { store, marks } = recordingStore();
    setSandboxUsageStore(store);

    const { createSandboxForProject } = await import('./service');
    const started = await createSandboxForProject('prj_1', {}, { userId: 'u1' });

    expect(started.sandboxId).toBe('sb-new');
    expect(marks).toEqual([
      { event: 'create', sandboxId: 'sb-new', userId: 'u1', projectId: 'prj_1', at: expect.any(Number) },
    ]);
  });

  it('records a resume with the caller’s attribution', async () => {
    const { store, marks } = recordingStore();
    setSandboxUsageStore(store);

    const { resumeSandbox } = await import('./service');
    await resumeSandbox('sb-1', {}, { userId: 'u1', projectId: 'prj_1' });

    expect(marks).toEqual([
      { event: 'resume', sandboxId: 'sb-1', userId: 'u1', projectId: 'prj_1', at: expect.any(Number) },
    ]);
  });

  it('records a hibernate and a delete when they SUCCEED', async () => {
    const { store, marks } = recordingStore();
    setSandboxUsageStore(store);

    const { hibernateSandbox, deleteSandbox } = await import('./service');
    await hibernateSandbox('sb-1', {}, { userId: 'u1', projectId: 'prj_1' });
    await deleteSandbox('sb-1', {}, { userId: 'u1', projectId: 'prj_1' });

    expect(marks.map((m) => m.event)).toEqual(['hibernate', 'delete']);
  });

  it('writes NO mark when the hibernate FAILS — the VM is still running and still billing', async () => {
    /*
     * 🔴 The interval must stay OPEN. A close mark here would stop the meter in the report while the
     * provider's meter kept turning, so the report would under-state cost precisely when the cost is
     * real — and hibernate is best-effort, so nothing else would ever notice.
     */
    const { store, marks } = recordingStore();
    setSandboxUsageStore(store);
    sandboxes.hibernate.mockRejectedValue(new Error('provider said no'));

    const { hibernateSandbox } = await import('./service');

    // Still best-effort towards its caller: a failed hibernate is a bill, not a broken request.
    await expect(hibernateSandbox('sb-1', {}, { userId: 'u1' })).resolves.toBeUndefined();
    expect(marks).toEqual([]);
  });

  it('writes NO mark when the delete FAILS', async () => {
    /* A failed delete throws deliberately — an orphan VM must be loud — and it is still running. */
    const { store, marks } = recordingStore();
    setSandboxUsageStore(store);
    sandboxes.delete.mockRejectedValue(new Error('provider said no'));

    const { deleteSandbox } = await import('./service');

    await expect(deleteSandbox('sb-1', {}, { userId: 'u1' })).rejects.toThrow(/provider said no/);
    expect(marks).toEqual([]);
  });

  it('a store outage never fails create, resume or delete', async () => {
    /*
     * The reason the whole feature is allowed to exist on these paths. If this inverts, an accounting
     * table nobody looks at can stop a user opening their project.
     */
    const { store, breakIt } = recordingStore();
    breakIt();
    setSandboxUsageStore(store);

    const { createSandboxForProject, resumeSandbox, deleteSandbox, hibernateSandbox } = await import('./service');

    await expect(createSandboxForProject('prj_1', {}, { userId: 'u1' })).resolves.toMatchObject({
      sandboxId: 'sb-new',
    });
    await expect(resumeSandbox('sb-1', {}, { userId: 'u1' })).resolves.toMatchObject({ sandboxId: 'sb-1' });
    await expect(hibernateSandbox('sb-1', {}, { userId: 'u1' })).resolves.toBeUndefined();
    await expect(deleteSandbox('sb-1', {}, { userId: 'u1' })).resolves.toBeUndefined();
  });
});
