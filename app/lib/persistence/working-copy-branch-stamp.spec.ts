/**
 * 🔴 THE BRANCH STAMP REACHES THE SERVER COPY, ON BOTH PATHS (§4.13a T17).
 *
 * `selectMountSource` refuses to restore a working copy whose stamp disagrees with the project's
 * `linked_branch` — which makes an ABSENT stamp expensive rather than merely unknown: an unstamped
 * copy is waved through as "cannot say", so a writer that forgets the field silently turns the whole
 * guard off for that project, and nothing anywhere reports it.
 *
 * Two properties, and the second is the one no ordinary behavioural test in this repo would see.
 *
 * ## 1. The writer READS the branch; it is not passed in
 *
 * `writeWorkingCopyFromStore` has four call sites and only one of them (`applyBranchTree`) knows what
 * a branch is. So the value comes from `repoStatus` — the store already authoritative about where the
 * project lives — which no caller can forget to consult. That is the `isSecretPath` rule applied to a
 * field instead of a predicate: one source, one place, at every door.
 *
 * ## 2. The WORKER forwards it
 *
 * The worker is the DEFAULT path (the inline `fetch` is only the fallback when a `Worker` cannot be
 * constructed), and the two encode the envelope independently. A worker that dropped `branch` from its
 * `buildWorkingCopyBody` call would stamp correctly in every test that drives the fallback and
 * unstamp every real save in production — a difference invisible to any test that stubs `postMessage`
 * and asserts on the payload it captured. So the real worker module is driven here: `self` is stubbed,
 * the module registers its `onmessage`, and the test hands it a request and reads the bytes it PUTs.
 *
 * ⚠️ `vi.resetModules()` before each load is load-bearing — the writer caches its `Worker` in module
 * state, and `repoStatus` must be read out of the SAME module graph the writer imported, or the test
 * sets a branch on one instance of the store and the writer reads another.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Every `postMessage` the writer made, as the worker would have received it. */
let posted: Array<{ requestId: number; url: string; seq: number; messageId?: string; branch?: string }>;

/** Every `fetch` the writer or the worker made, so the inline path can be read the same way. */
let fetched: Array<{ url: string; body: string }>;

class CapturingWorker {
  onmessage: ((event: { data: { requestId: number; ok: boolean } }) => void) | null = null;
  onerror: (() => void) | null = null;

  postMessage(message: any) {
    posted.push(message);
    queueMicrotask(() => this.onmessage?.({ data: { requestId: message.requestId, ok: true } }));
  }

  terminate() {}
}

/**
 * Load the writer against a stubbed file store.
 *
 * Text-only on purpose: this file is about the STAMP, and `working-copy-detach.spec.ts` already owns
 * the binary-transfer contract. Keeping bytes out means nothing here can be detached, so a failure
 * points at the field rather than at the buffer.
 */
async function loadWriter() {
  vi.resetModules();

  vi.doMock('~/lib/stores/workbench', () => ({
    workbenchStore: {
      files: {
        get: () => ({
          '/home/project/src/main.ts': { type: 'file', content: 'export const go = 1;', isBinary: false, size: 20 },
        }),
      },
      readBinaryFile: async () => new Uint8Array(0),
    },
  }));

  /* Both out of the same registry — see the module note. */
  const { repoStatus } = await import('./useChatHistory');
  const { writeWorkingCopyFromStore } = await import('./working-copy-writer');

  return { repoStatus, writeWorkingCopyFromStore };
}

beforeEach(() => {
  posted = [];
  fetched = [];

  vi.stubGlobal('Worker', CapturingWorker);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      fetched.push({ url: String(url), body: String(init?.body ?? '') });
      return { ok: true, status: 200 } as unknown as Response;
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  vi.restoreAllMocks();
});

describe('the writer reads the branch from the store, not from its arguments', () => {
  it('stamps the copy with whatever branch the project is currently on', async () => {
    const { repoStatus, writeWorkingCopyFromStore } = await loadWriter();

    repoStatus.set({ linked: true, branch: 'feature/hud' });

    /* Three arguments — the caller never mentions a branch, and the stamp arrives anyway. */
    expect(await writeWorkingCopyFromStore('prj_kart', 3, 'msg-9')).toBe('saved');

    expect(posted).toHaveLength(1);
    expect(posted[0].branch).toBe('feature/hud');
    expect(posted[0].messageId).toBe('msg-9');
    expect(posted[0].seq).toBe(3);
    expect(posted[0].url).toBe('/api/projects/prj_kart/working');
  });

  /*
   * CONTROL. The assertion above passes for a writer that hardcoded a branch, or for a store that was
   * never read — this is the same call with the store holding a DIFFERENT branch, so the two together
   * say the value tracks the store rather than merely being present.
   */
  it('CONTROL — a different branch in the store produces a different stamp', async () => {
    const { repoStatus, writeWorkingCopyFromStore } = await loadWriter();

    repoStatus.set({ linked: true, branch: 'main' });
    await writeWorkingCopyFromStore('prj_kart', 3);

    expect(posted[0].branch).toBe('main');
  });

  /*
   * An unlinked project has no branch, and one is not invented for it. `undefined` reads as UNKNOWN
   * downstream, which is the pre-T17 behaviour — inventing `'main'` here would be a stamp that could
   * accidentally MATCH, i.e. a guard that says yes for a reason nobody chose.
   */
  it('leaves the stamp absent when the project has no branch', async () => {
    const { repoStatus, writeWorkingCopyFromStore } = await loadWriter();

    repoStatus.set({ linked: false });
    await writeWorkingCopyFromStore('prj_kart', 3);

    expect(posted[0].branch).toBeUndefined();
  });

  it('leaves the stamp absent when the repo status has not loaded yet', async () => {
    const { writeWorkingCopyFromStore } = await loadWriter();

    // `repoStatus` starts undefined; a save racing the status read must not throw or fabricate.
    await writeWorkingCopyFromStore('prj_kart', 3);

    expect(posted[0].branch).toBeUndefined();
  });

  /*
   * The INLINE fallback (no `Worker` available: SSR, or an unsupported browser) encodes the envelope
   * itself, so it is a second place the field can be dropped. It must put exactly the same stamp on
   * the wire as the worker path.
   */
  it('stamps identically on the inline fallback path', async () => {
    vi.stubGlobal('Worker', undefined);

    const { repoStatus, writeWorkingCopyFromStore } = await loadWriter();

    repoStatus.set({ linked: true, branch: 'feature/hud' });
    expect(await writeWorkingCopyFromStore('prj_kart', 3, 'msg-9')).toBe('saved');

    expect(posted).toHaveLength(0);
    expect(fetched).toHaveLength(1);

    const body = JSON.parse(fetched[0].body);
    expect(body.branch).toBe('feature/hud');
    expect(body.messageId).toBe('msg-9');
    expect(body.seq).toBe(3);
  });
});

/**
 * The WORKER half — driven for real, not scanned.
 *
 * The worker is the default path in a browser, so if it drops `branch` between its message and its
 * `buildWorkingCopyBody` call, every production save is unstamped while the fallback tests stay green.
 * `self` is stubbed so the module can register its handler in node; from there it is an ordinary
 * function taking a message and making a `fetch`.
 */
describe('the encode worker forwards the stamp it was given', () => {
  async function loadWorker() {
    vi.resetModules();

    const scope: { onmessage: ((event: { data: unknown }) => void) | null; postMessage: (m: unknown) => void } = {
      onmessage: null,
      postMessage: vi.fn(),
    };

    vi.stubGlobal('self', scope);
    await import('./working-copy.worker');

    return scope;
  }

  const entries = [{ path: '/home/project/src/main.ts', isBinary: false, text: 'export const go = 1;' }];

  it('puts the branch it received into the envelope it uploads', async () => {
    const scope = await loadWorker();

    scope.onmessage!({
      data: {
        requestId: 1,
        url: '/api/projects/prj_kart/working',
        seq: 3,
        messageId: 'msg-9',
        branch: 'feature/hud',
        entries,
      },
    });

    await vi.waitFor(() => expect(fetched).toHaveLength(1));

    const body = JSON.parse(fetched[0].body);
    expect(body.branch).toBe('feature/hud');
    expect(body.messageId).toBe('msg-9');
    expect(body.seq).toBe(3);
    expect(body.files['/home/project/src/main.ts'].content).toBe('export const go = 1;');
  });

  /*
   * CONTROL. The test above passes for a worker that hardcoded a branch; this is the same request with
   * the field absent, which must produce the pre-T17 envelope rather than an invented stamp.
   */
  it('CONTROL — a request with no branch uploads an unstamped envelope', async () => {
    const scope = await loadWorker();

    scope.onmessage!({
      data: { requestId: 1, url: '/api/projects/prj_kart/working', seq: 3, entries },
    });

    await vi.waitFor(() => expect(fetched).toHaveLength(1));

    const body = JSON.parse(fetched[0].body);
    expect(body.branch).toBeUndefined();
    expect(body.seq).toBe(3);
  });
});

/**
 * A SOURCE SCAN, and only for the thing behaviour cannot show: that `branch` is not a PARAMETER.
 *
 * Everything above proves the stamp arrives. None of it can prove it arrives *from the store rather
 * than from an argument some future caller must remember to pass* — a writer with an optional
 * `branch` parameter defaulting to `repoStatus.get()?.branch` would satisfy every assertion in this
 * file while re-opening exactly the hole T17 closed, because the first caller to pass `undefined`
 * explicitly would unstamp the copy.
 *
 * Comments are stripped first (the module's own doc comment names both the store and the field, so an
 * unstripped scan would match the prose and pass for an implementation that does neither), and each
 * assertion carries a control proving the scanner still sees what it is looking at.
 */
describe('source: the branch is read from the store, never accepted as an argument', () => {
  const WRITER = path.join(process.cwd(), 'app/lib/persistence/working-copy-writer.ts');

  /** Block and line comments removed, so a scan can only match executable source. */
  function code(file: string): string {
    return fs
      .readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
  }

  it('reads it from the shared store reader', () => {
    const source = code(WRITER);

    expect(source).toContain('branchForWorkingCopy()');

    /* CONTROL: the scanner is looking at real, comment-stripped source. */
    expect(source).toContain('export async function writeWorkingCopyFromStore');
    expect(source).not.toContain('🔴 THE BRANCH STAMP IS READ HERE');
  });

  /**
   * 🔴 AND SO DOES THE OTHER WRITER — the one that made this rule necessary.
   *
   * `projects.ts`'s `saveWorkingCopy` PUTs the same object by a different route, and it is the
   * per-generation checkpoint's writer: the most frequent working-copy write in the product. While it
   * could not reach the store (an import cycle — `useChatHistory` imports `projects.ts`) it wrote
   * every copy unstamped, and because a PUT replaces the whole object it also ACTIVELY UN-STAMPED:
   * `applyBranchTree` would stamp `feature/hud` and the next generation would overwrite the copy with
   * nothing, giving the guard a lifetime of one turn. Both failures are silent — an unstamped copy
   * reads as UNKNOWN, which is correct-by-default and therefore never complains.
   *
   * ⚠️ Pinned as a SCAN over BOTH writers rather than as one behavioural test, because the defect was
   * never in either function's behaviour — it was in one of them not existing in the other's world.
   * That is the `recordAgentWrite`/`#recordRestoredFiles` shape: one half of a pair guarded, the
   * other not, with a comment asserting they match.
   */
  it('and so does the checkpoint writer in projects.ts', () => {
    const source = code(path.join(process.cwd(), 'app/lib/persistence/projects.ts'));

    expect(source).toContain('branchForWorkingCopy()');
    expect(source).toMatch(/branch:\s*branchForWorkingCopy\(\)/);

    /* CONTROL: the scanner reads real code, and the strip really stripped. */
    expect(source).toContain('export async function saveWorkingCopy');
    expect(source).not.toContain('THE BRANCH STAMP (§4.13a T17)');
  });

  /**
   * 🔴 ONE READER, ONE ANSWER. Neither writer may re-derive the branch with its own optional chain:
   * two spellings of one question is how they come to disagree, which is the `isSecretPath` rule and
   * the `kieEnvModel` two-readers rule in the same sentence.
   */
  it('neither writer re-derives the branch itself', () => {
    for (const file of [WRITER, path.join(process.cwd(), 'app/lib/persistence/projects.ts')]) {
      expect(code(file)).not.toMatch(/repoStatus\.get\(\)\??\.?\??\.branch/);
    }
  });

  it('does not take a branch parameter', () => {
    const signature = code(WRITER).match(/export async function writeWorkingCopyFromStore\s*\(([^)]*)\)/);

    expect(signature, 'the writer signature must be findable for this scan to mean anything').toBeTruthy();
    expect(signature![1]).not.toMatch(/\bbranch\b/);

    /* CONTROL: the captured signature is the real one, so "no branch" is a finding and not an artefact. */
    expect(signature![1]).toMatch(/\bprojectId\b/);
    expect(signature![1]).toMatch(/\bmessageId\b/);
  });
});
