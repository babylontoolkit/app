/**
 * Which sandbox runtime this build uses, and the facts that follow from it.
 *
 * Client-safe and dependency-free ON PURPOSE: `app/entry.server.tsx` (the server render) and
 * `~/lib/sandbox/index.ts` (the browser seam) both need these answers, and importing the seam into
 * the server render would pull a browser runtime — and its eager boot — into the Node bundle.
 *
 * 🔴 **Every fact here is a RECORD keyed by provider id, never a comparison against one id.** The two
 * flags in `~/lib/sandbox/index.ts` and the isolation header in `entry.server.tsx` were all written as
 * `!== 'codesandbox'`, and all three doc comments independently warned that a third provider would
 * then inherit an answer by omission. `entry.server.tsx` said it outright: *"When the third provider
 * lands, make this a property of the provider rather than a list of the ones that do not — the same
 * lesson as `coversWorkspace`'s phase gate, where an enumeration of the known doors missed the third."*
 * This module is that change. A `Record<SandboxProviderId, …>` will not compile until a new provider
 * has answered every question, which is the difference between a rule and a hope.
 */

export type SandboxProviderId = 'nodepod' | 'webcontainer' | 'codesandbox';

export const SANDBOX_PROVIDER_IDS: readonly SandboxProviderId[] = ['nodepod', 'webcontainer', 'codesandbox'];

/**
 * The default when `VITE_SANDBOX_PROVIDER` is unset — **Nodepod** since 2026-07-31.
 *
 * 🔴 The reasoning inverted when the default moved. The old rule was "anything unrecognised means
 * WebContainer, because falling back to the incumbent is safe", which was true while the incumbent was
 * free. It is not: WebContainers is priced at ~$10,000 per 8,000 API calls and CodeSandbox bills per
 * VM-hour, so an unset or mistyped variable silently selecting either one starts SPENDING money.
 * Nodepod needs no credential and no VM, so for the first time the intended provider and the safe
 * fallback are the same answer.
 */
export const DEFAULT_SANDBOX_PROVIDER: SandboxProviderId = 'nodepod';

/**
 * Which providers this build may actually select. **Nodepod only, since 2026-07-31.**
 *
 * 🔴 **A DISABLED PROVIDER CANNOT BE CHOSEN BY CONFIGURATION — ONLY BY EDITING THIS LINE.** That is
 * the entire point of the list existing separately from {@link SANDBOX_PROVIDER_IDS}: `.env` files,
 * Docker build args, SSM parameters and CI variables are all things that can be set by accident, by a
 * stale copy of a deploy script, or by a machine that has been configured for a different build. None
 * of them may start a WebContainer.
 *
 * Two reasons, and the first is not a cost question:
 *
 *   - **WebContainers is proprietary and commercially licensed** (`spec/licensing.md`). Running it on
 *     a paid platform without a StackBlitz agreement is a licence violation, and it would not announce
 *     itself — the runtime works perfectly, which is exactly why it must be impossible to reach by
 *     accident rather than merely non-default. A default is a preference; this is a wall.
 *   - **CodeSandbox bills per VM-hour.** A build that reaches it starts spending on someone's card.
 *
 * The code for both stays in the tree, complete and tested — this is hide-don't-delete, and the seam
 * is the reason a dormant provider costs nothing to keep. Neither module is even *evaluated* on a
 * Nodepod build (both branches of `connectProvider` are dynamic imports), so a disabled provider is
 * not a download, not a boot, and not a WASM fetch.
 *
 * ## To re-enable one for debugging
 *
 *   1. add its id here (e.g. `['nodepod', 'webcontainer']`);
 *   2. update `sandbox-runtime.spec.ts`, which pins this list — CI fails otherwise, deliberately, so
 *      that turning a paid or licensed runtime back on is a reviewed change and never a stray commit;
 *   3. build with `VITE_SANDBOX_PROVIDER=<id>` (it is a BUILD-time switch — see DEPLOY.md);
 *   4. **put it back.** For WebContainer, do not ship the result.
 *
 * ⚠️ Step 1 alone is not enough and that is intentional. An operator with shell access on a running
 * container still cannot enable either runtime, because the client bundle chose at build time.
 */
export const ENABLED_SANDBOX_PROVIDERS: readonly SandboxProviderId[] = ['nodepod'];

/**
 * May this build select the given provider?
 *
 * Exported so the seam can refuse a second time at the point of connection. One wall in the resolver
 * is not enough for a licence question: the resolver is a pure function that a future call site could
 * simply not use, whereas `connectProvider` is the only door to a runtime.
 */
export function isSandboxProviderEnabled(id: SandboxProviderId): boolean {
  return ENABLED_SANDBOX_PROVIDERS.includes(id);
}

export interface SandboxProviderTraits {
  /**
   * Where this runtime puts the user's project.
   *
   * 🔴 A property of the runtime, so it belongs with the runtime's other properties. `WORK_DIR` used
   * to compute it as `VITE_SANDBOX_PROVIDER === 'codesandbox' ? … : '/home/project'` — the same
   * `!== codesandbox` shape this module was created to remove, and the one instance that was missed
   * when the other three were converted. It happens to give Nodepod the right answer, which is
   * precisely why it survived: an anti-pattern that is accidentally correct is invisible.
   *
   * Getting it wrong is silent both ways — the watcher fills the map with correct keys while the
   * tree renders `rootFolder={WORK_DIR}` and matches none of them, so the workbench shows an EMPTY
   * project on top of a full one (MEASURED live on the CodeSandbox swap).
   *
   * ⚠️ Must be a member of `SANDBOX_ROOTS` (`~/lib/common/sandbox-paths.ts`), which recognises the
   * roots of OTHER providers too — a working copy outlives the provider that wrote it. Pinned by
   * `sandbox-runtime.spec.ts` rather than left to the comment.
   */
  readonly workdir: string;

  /**
   * Can the project's files survive this browser session?
   *
   * Drives the save nudges (§4.5.4b). A browser-side runtime's filesystem dies with the tab, so "it
   * exists only in this browser tab" is literally true; on a server VM that sentence is FALSE, and a
   * warning the user can disprove teaches them to ignore the next one.
   */
  readonly outlivesSession: boolean;

  /** Does booting need to know WHICH project it is for? True only when the sandbox IS the project's VM. */
  readonly requiresProject: boolean;

  /**
   * Does this runtime need `COOP: same-origin` + `COEP: require-corp`?
   *
   * ⚠️ Isolation is not free: under `require-corp` a cross-origin iframe whose response carries no
   * `Cross-Origin-Resource-Policy` header is refused outright (ERR_BLOCKED_BY_RESPONSE) — measured
   * live as a CodeSandbox preview rendering "refused to connect" over a perfectly healthy dev server.
   * So this is a real cost, paid only by runtimes that genuinely need SharedArrayBuffer.
   *
   * NOTE: this is about the RUNTIME, never about the game. Havok does not need SharedArrayBuffer
   * (SPEC §4.4, corrected 2026-07-31 against the shipped wasm).
   */
  readonly needsCrossOriginIsolation: boolean;
}

export const SANDBOX_PROVIDER_TRAITS: Record<SandboxProviderId, SandboxProviderTraits> = {
  /*
   * Browser-side and tab-local. The VFS is empty on every page load — the snapshot cache restores
   * `node_modules`, never the user's source — and there is no VM to mint or own, which is the entire
   * reason it costs nothing when a user walks away. Its sync VFS bridge is `Atomics.wait` over a
   * SharedArrayBuffer, so isolation is mandatory: without it `boot()` throws.
   */
  nodepod: {
    workdir: '/home/project',
    outlivesSession: false,
    requiresProject: false,
    needsCrossOriginIsolation: true,
  },

  /* Tab-local WASM VM; SharedArrayBuffer is what makes the runtime exist at all. */
  webcontainer: {
    workdir: '/home/project',
    outlivesSession: false,
    requiresProject: false,
    needsCrossOriginIsolation: true,
  },

  /* A server microVM: it holds the files on a remote disk, it IS the project, and it needs no SAB. */
  codesandbox: {
    workdir: '/project/workspace',
    outlivesSession: true,
    requiresProject: true,
    needsCrossOriginIsolation: false,
  },
};

/**
 * Resolve the configured id, reporting anything unrecognised rather than coercing it silently.
 *
 * Pure, and takes the raw value as an argument, so it is testable without stubbing `import.meta.env`.
 * A build running a different runtime than its config asked for is exactly the mismatch that gets
 * misdiagnosed as "the sandbox is broken", so the fallback is loud.
 */
export function resolveSandboxProviderId(
  configured: string | undefined,
  warn: (message: string) => void = () => {},
): SandboxProviderId {
  if (!configured) {
    return DEFAULT_SANDBOX_PROVIDER;
  }

  if ((SANDBOX_PROVIDER_IDS as readonly string[]).includes(configured)) {
    const id = configured as SandboxProviderId;

    if (isSandboxProviderEnabled(id)) {
      return id;
    }

    /*
     * 🔴 A REAL provider name that this build refuses. Distinguished from a typo because the two need
     * different sentences: a typo is a mistake to correct, this is a deliberate wall the reader must
     * be told about by name, or they will spend an afternoon convinced their config is being ignored.
     */
    warn(
      `[sandbox] VITE_SANDBOX_PROVIDER="${configured}" is DISABLED in this build ` +
        `(enabled: ${ENABLED_SANDBOX_PROVIDERS.join(', ')}); using ${DEFAULT_SANDBOX_PROVIDER}. ` +
        `See ENABLED_SANDBOX_PROVIDERS in app/lib/common/sandbox-runtime.ts.`,
    );

    return DEFAULT_SANDBOX_PROVIDER;
  }

  warn(
    `[sandbox] VITE_SANDBOX_PROVIDER="${configured}" is not one of ${SANDBOX_PROVIDER_IDS.join(', ')}; ` +
      `using ${DEFAULT_SANDBOX_PROVIDER}.`,
  );

  return DEFAULT_SANDBOX_PROVIDER;
}
