/**
 * The deferred, project-scoped boot behind the seam entry (`~/lib/sandbox`, SPEC §8).
 *
 * The eager module-scope boot this replaced had three properties that were fine for a tab-local WASM
 * runtime and wrong for a server-backed VM, each failing without an exception:
 *
 *   - it booted for NOBODY, and a sandbox on this provider belongs to a project (its id lives on the
 *     project row) — so "boot first, find out whose later" means adopting whichever VM answers;
 *   - a rejection was CACHED in a module-level promise, so the server's deliberately-retryable 503
 *     was terminal in the client and a full page reload was the only cure — which is precisely what
 *     the boot screen's "Try again" must not require;
 *   - nothing noticed a second project being asked for, so the stores (which capture ONE promise in
 *     their constructors) would keep talking to the first VM while the UI showed the second project.
 *
 * ⚠️ **`VITE_SANDBOX_PROVIDER` is stubbed in BOTH directions on purpose.** It is read at module
 * evaluation time, and `vite.config.ts` loads the developer's `.env.local` into the test run — so on
 * a machine that has `VITE_SANDBOX_PROVIDER=codesandbox` set (the owner's does), a spec that only
 * stubbed the codesandbox case would silently test that build twice and pass with the WebContainer
 * assertions never exercised. Same family as the `env()` trap in `oauth.spec.ts`: a seam that LOOKS
 * empty and quietly resolves to the real thing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SandboxProvider } from './types';

const bootCodeSandbox = vi.hoisted(() => vi.fn());
const createCodeSandboxProvider = vi.hoisted(() => vi.fn());
const createWebContainerProvider = vi.hoisted(() => vi.fn());
const webcontainerBooted = vi.hoisted(() => vi.fn());

vi.mock('./codesandbox-boot', () => ({ bootCodeSandbox }));
vi.mock('./codesandbox-provider', () => ({ createCodeSandboxProvider }));
vi.mock('./webcontainer-provider', () => ({ createWebContainerProvider }));
vi.mock('~/lib/webcontainer', () => ({
  get webcontainer() {
    webcontainerBooted();
    return Promise.resolve({ runtime: 'wc' });
  },
}));

type Seam = typeof import('./index');

/**
 * Evaluate the seam entry fresh for a given build.
 *
 * A fresh module each time because the boot STATE lives at module scope — one tab, one connection —
 * so every test needs its own tab.
 *
 * ⚠️ Error classes are therefore asserted through the SEAM'S OWN re-exports, never a top-level import
 * of `./errors`: `vi.resetModules()` gives the freshly-imported seam a fresh `errors` module too, so a
 * statically-imported class is a DIFFERENT constructor and every `instanceof` fails — a spec artefact
 * that reads exactly like the refusal not firing.
 */
async function loadSeam(provider: 'codesandbox' | 'webcontainer'): Promise<Seam> {
  vi.resetModules();
  vi.stubEnv('SSR', false as never);
  vi.stubEnv('VITE_SANDBOX_PROVIDER', provider);

  return import('./index');
}

/** A provider double that is only ever compared by identity. */
function providerDouble(label: string): SandboxProvider {
  return { label } as unknown as SandboxProvider;
}

/** Did a promise reject, or is it still pending / resolved? Never awaits a pending promise forever. */
async function settledState(promise: Promise<unknown>): Promise<'pending' | 'resolved' | 'rejected'> {
  return Promise.race([
    promise.then(
      () => 'resolved' as const,
      () => 'rejected' as const,
    ),
    Promise.resolve().then(() => 'pending' as const),
  ]);
}

beforeEach(() => {
  vi.clearAllMocks();
  bootCodeSandbox.mockResolvedValue({
    client: {},
    projectId: 'prj_a',
    sandboxId: 'sb_1',
    bootRestoredFilesystem: true,
    mintPreviewUrl: vi.fn(),
  });
  createCodeSandboxProvider.mockImplementation(() => providerDouble('codesandbox'));
  createWebContainerProvider.mockImplementation(() => providerDouble('webcontainer'));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('a server-backed build', () => {
  it('does NOT boot at module load — there is no project yet to boot for', async () => {
    const seam = await loadSeam('codesandbox');

    expect(seam.SANDBOX_REQUIRES_PROJECT).toBe(true);
    expect(bootCodeSandbox).not.toHaveBeenCalled();
    expect(seam.bootedProjectId()).toBeUndefined();
  });

  /*
   * 🔴 The project id reaches the boot, and the tab remembers which project it is bound to. Everything
   * downstream — the session request, the reconnect, the preview mint, the identity sentinel — is
   * scoped by this one value.
   */
  it('boots for the project it was given and records it', async () => {
    const seam = await loadSeam('codesandbox');
    const provider = await seam.bootForProject('prj_a');

    expect(bootCodeSandbox.mock.calls[0][0]).toBe('prj_a');
    expect(seam.bootedProjectId()).toBe('prj_a');

    /*
     * The compatibility contract: stores captured this exact promise in their CONSTRUCTORS, so what
     * changed is only when it resolves — never that it is a different object.
     */
    await expect(seam.sandbox).resolves.toBe(provider);
  });

  /*
   * Idempotent, because the mount path calls it on every mount and a second VM is both a second bill
   * and a second filesystem. Concurrent callers join the boot in flight rather than forking one.
   */
  it('joins the boot already running instead of forking a second VM', async () => {
    const seam = await loadSeam('codesandbox');

    const [a, b] = await Promise.all([seam.bootForProject('prj_a'), seam.bootForProject('prj_a')]);
    const c = await seam.bootForProject('prj_a');

    expect(bootCodeSandbox).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    expect(c).toBe(a);
  });

  /*
   * 🔴 ONE TAB, ONE SANDBOX. The stores hold a single captured promise, so there is no way to re-point
   * them mid-page: a silent rebind would leave every store talking to project A while the UI renders
   * project B. Refusing is what makes the dashboard's full page load correct rather than merely
   * cautious — and the refusal is described, so `describeSandboxFailure` can put "reload" on screen.
   */
  it('refuses a boot for a different project once bound', async () => {
    const seam = await loadSeam('codesandbox');
    await seam.bootForProject('prj_a');

    await expect(seam.bootForProject('prj_b')).rejects.toBeInstanceOf(seam.SandboxProjectMismatchError);
    expect(bootCodeSandbox).toHaveBeenCalledTimes(1);
  });

  /** Same refusal while the first boot is still in flight — the window a fast A→B click lands in. */
  it('refuses a different project mid-boot, before the first has settled', async () => {
    const seam = await loadSeam('codesandbox');

    let release!: (value: unknown) => void;
    bootCodeSandbox.mockReturnValueOnce(new Promise((resolve) => (release = resolve)));

    const first = seam.bootForProject('prj_a');
    const second = seam.bootForProject('prj_b');

    await expect(second).rejects.toBeInstanceOf(seam.SandboxProjectMismatchError);
    expect(seam.bootedProjectId()).toBe('prj_a');

    release({ client: {}, sandboxId: 'sb_1', bootRestoredFilesystem: true, mintPreviewUrl: vi.fn() });
    await expect(first).resolves.toBeDefined();
  });

  /*
   * There is no session to mint without a project, and a placeholder would have to invent one — which
   * on this provider means somebody else's VM. Unretryable on purpose: no amount of pressing "Try
   * again" conjures a project id, so offering the button would be a lie.
   */
  it('refuses to boot for nobody, and says a retry will not help', async () => {
    const seam = await loadSeam('codesandbox');

    await expect(seam.bootForProject()).rejects.toBeInstanceOf(seam.SandboxUnavailableError);
    await expect(seam.bootForProject()).rejects.toMatchObject({ retryable: false });
    expect(bootCodeSandbox).not.toHaveBeenCalled();
  });

  /*
   * 🔴 THE RETRY. The previous design cached the boot promise, so a 503 the SERVER had deliberately
   * marked retryable was terminal in the CLIENT: the boot screen could offer a button, but the only
   * thing that actually worked was a page reload. A failed attempt must clear itself completely —
   * including the in-flight project id, or the retry is refused as a mismatch against a boot that
   * never happened.
   */
  it('does not cache a rejection — the next attempt genuinely retries', async () => {
    const seam = await loadSeam('codesandbox');

    bootCodeSandbox.mockRejectedValueOnce(new seam.SandboxUnavailableError('Could not reach the provider.'));
    await expect(seam.bootForProject('prj_a')).rejects.toBeInstanceOf(seam.SandboxUnavailableError);
    expect(seam.bootedProjectId()).toBeUndefined();

    const provider = await seam.bootForProject('prj_a');

    expect(bootCodeSandbox).toHaveBeenCalledTimes(2);
    expect(seam.bootedProjectId()).toBe('prj_a');
    await expect(seam.sandbox).resolves.toBe(provider);
  });

  /*
   * 🔴 And the promise the stores are holding must SURVIVE that failure. Rejecting it would poison the
   * value `filesStore`, `previewsStore` and the terminal store captured at construction — permanently,
   * for the life of the page — so even a successful retry would leave every one of them holding a
   * dead promise. Pending is the honest state: nothing has booted yet.
   */
  it('leaves the shared promise pending through a failure, then resolves it on the retry', async () => {
    const seam = await loadSeam('codesandbox');

    bootCodeSandbox.mockRejectedValueOnce(new seam.SandboxUnavailableError('nope'));
    await expect(seam.bootForProject('prj_a')).rejects.toBeInstanceOf(seam.SandboxUnavailableError);

    expect(await settledState(seam.sandbox)).toBe('pending');

    const provider = await seam.bootForProject('prj_a');
    await expect(seam.sandbox).resolves.toBe(provider);
  });

  /** The vendor that is NOT chosen is never even evaluated — a static import is a decision to run it. */
  it('never touches the WebContainer runtime', async () => {
    const seam = await loadSeam('codesandbox');
    await seam.bootForProject('prj_a');

    expect(webcontainerBooted).not.toHaveBeenCalled();
    expect(createWebContainerProvider).not.toHaveBeenCalled();
  });
});

describe('a WebContainer build', () => {
  /*
   * Unchanged behaviour, and the reason the flag is DERIVED rather than compared at each call site: a
   * tab-local WASM VM has no server record and no identity, so it still boots eagerly with no project
   * — and a project-scoped refusal here would break the incumbent provider outright.
   */
  it('still boots eagerly, with no project and no refusal', async () => {
    const seam = await loadSeam('webcontainer');

    expect(seam.SANDBOX_REQUIRES_PROJECT).toBe(false);
    expect(seam.SANDBOX_OUTLIVES_SESSION).toBe(false);

    await expect(seam.sandbox).resolves.toBeDefined();
    expect(createWebContainerProvider).toHaveBeenCalledTimes(1);
    expect(bootCodeSandbox).not.toHaveBeenCalled();
  });

  /*
   * A project id is accepted and ignored rather than refused: the mount path passes one on every
   * provider, and one tab-local runtime genuinely does serve whichever project the tab is showing.
   */
  it('does not refuse a second project, because there is no per-project VM to mismatch', async () => {
    const seam = await loadSeam('webcontainer');

    await expect(seam.bootForProject('prj_a')).resolves.toBeDefined();
    await expect(seam.bootForProject('prj_b')).resolves.toBeDefined();
    expect(createWebContainerProvider).toHaveBeenCalledTimes(1);
  });
});

/*
 * `requireBootedSandbox()` — the seam for callers that await it OUTSIDE a project (importing a git
 * repo or a local folder from the landing page). Its whole job is to convert one silent failure into
 * a sentence, without changing anything for the provider that never had the failure.
 */
describe('the sandbox demanded outside a project', () => {
  /*
   * 🔴 THE INCUMBENT IS UNAFFECTED. On WebContainer this must be `sandbox` VERBATIM — the same object,
   * resolving to the same provider — because that runtime boots eagerly and needs no project, so every
   * landing-page import/clone flow has to behave exactly as it did before this function existed. The
   * identity assertion is the one that carries the guarantee: "resolves to a provider" would also pass
   * for a wrapper that quietly substituted a different promise, and the substitution is the whole risk.
   */
  it('WebContainer: hands back the shared promise verbatim and never refuses', async () => {
    const seam = await loadSeam('webcontainer');
    const booted = await seam.sandbox;

    expect(seam.requireBootedSandbox()).toBe(seam.sandbox);
    await expect(seam.requireBootedSandbox()).resolves.toBe(booted);
  });

  /*
   * 🔴 And it must not refuse in the ONE state where a mis-polarised project guard is observable at
   * all: nothing booted and nothing in flight. On WebContainer that state is reachable only after the
   * eager boot has FAILED — everywhere else a boot is either running or done, and a guard written the
   * wrong way round returns the shared promise anyway and hides completely.
   *
   * A refusal here would break landing-page import on the provider that ships today, for users whose
   * WebContainer happened to fail once; the honest value is the shared promise, still pending, exactly
   * as the stores hold it.
   */
  it('WebContainer: still refuses nothing once the eager boot has failed', async () => {
    createWebContainerProvider.mockImplementationOnce(() => {
      throw new Error('WASM boot failed');
    });

    const seam = await loadSeam('webcontainer');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(seam.requireBootedSandbox()).toBe(seam.sandbox);
    expect(await settledState(seam.requireBootedSandbox())).toBe('pending');
  });

  /*
   * 🔴 THE HANG THIS EXISTS TO REMOVE. On a server-backed build with nothing booted, `sandbox` is a
   * promise that will never resolve — so awaiting it bare turns "this flow needs a project first"
   * into a spinner that runs forever with no error and nothing in the console. A described refusal is
   * the worst outcome the user can be given here that is still honest, and `retryable: false` is what
   * stops `describeSandboxFailure` offering a "Try again" button that cannot possibly help: no amount
   * of pressing it conjures a project.
   */
  it('server-backed, nothing booted: refuses with a described, unretryable error', async () => {
    const seam = await loadSeam('codesandbox');

    await expect(seam.requireBootedSandbox()).rejects.toBeInstanceOf(seam.SandboxUnavailableError);
    await expect(seam.requireBootedSandbox()).rejects.toMatchObject({
      retryable: false,
      message: expect.stringMatching(/project/i),
    });
    expect(bootCodeSandbox).not.toHaveBeenCalled();
  });

  /** Once a project HAS booted the refusal must stop — the condition is "no sandbox", not "server-backed". */
  it('server-backed, already booted: resolves to the live provider', async () => {
    const seam = await loadSeam('codesandbox');
    const provider = await seam.bootForProject('prj_a');

    await expect(seam.requireBootedSandbox()).resolves.toBe(provider);
  });

  /*
   * 🔴 THE IN-FLIGHT BRANCH, AND IT IS NOT A MICRO-OPTIMISATION. `state.sandbox` only ever RESOLVES —
   * that is deliberate, and it is what keeps a failed boot retryable for the stores that captured it
   * at construction. So handing THAT back while a boot is in flight means a caller whose boot then
   * FAILS waits forever: the exact hang this function was written to remove, reintroduced one branch
   * to the left, and invisible to every other test in this file because the shared promise pending is
   * the correct state everywhere else.
   *
   * Driven end to end: take the sandbox mid-boot, fail the boot, and require the caller to LEARN.
   * Asserted through `settledState` rather than `rejects`, so the regression reports as
   * `'pending' !== 'rejected'` instead of hanging the runner — a test that detects a hang must not be
   * one.
   */
  it('server-backed, boot in flight: rejects when that boot fails instead of hanging forever', async () => {
    let fail!: (error: Error) => void;
    const held = new Promise((_resolve, reject) => {
      fail = reject;
    });
    bootCodeSandbox.mockReturnValueOnce(held);

    const seam = await loadSeam('codesandbox');
    const boot = seam.bootForProject('prj_a');

    const required = seam.requireBootedSandbox();
    required.catch(() => {
      /* Handled by `settledState` below; caught here only so a pending failure is not also unhandled. */
    });

    expect(await settledState(required)).toBe('pending');

    fail(new seam.SandboxUnavailableError('Could not reach the provider.'));
    await expect(boot).rejects.toBeInstanceOf(seam.SandboxUnavailableError);

    expect(await settledState(required)).toBe('rejected');
  });
});

describe('an unrecognised VITE_SANDBOX_PROVIDER', () => {
  /*
   * 🔴 The expectation CHANGED on 2026-07-31, and the reason is worth more than the assertion.
   *
   * This used to require the fallback to be WebContainer, "the incumbent" — sound while the incumbent
   * was free. It is not: WebContainers is priced at ~$10,000 per 8,000 API calls and CodeSandbox bills
   * per VM-hour, so with the old rule a typo in a deploy config silently selected a PAID runtime.
   * Nodepod needs no credential and no VM, so the intended provider and the safe fallback are now the
   * same answer — the first time that has been true (`spec/sandbox-nodepod.md`).
   *
   * The test itself was never wrong; a test that encodes a decision has to be re-read when the
   * decision changes, rather than deleted because it went red.
   */
  it('falls back to Nodepod — the runtime that costs nothing — rather than to a paid provider', async () => {
    vi.resetModules();
    vi.stubEnv('SSR', false as never);
    vi.stubEnv('VITE_SANDBOX_PROVIDER', 'codesandobx');

    const seam = await import('./index');

    expect(seam.SANDBOX_PROVIDER).toBe('nodepod');
    expect(seam.SANDBOX_REQUIRES_PROJECT).toBe(false);
    expect(seam.SANDBOX_OUTLIVES_SESSION).toBe(false);
  });

  it('an UNSET variable lands on Nodepod too', async () => {
    vi.resetModules();
    vi.stubEnv('SSR', false as never);
    vi.stubEnv('VITE_SANDBOX_PROVIDER', undefined);

    const seam = await import('./index');

    expect(seam.SANDBOX_PROVIDER).toBe('nodepod');
  });
});
