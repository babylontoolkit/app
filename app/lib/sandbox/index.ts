/**
 * The sandbox entry point (SPEC §1.3.5, §8, `spec/sandbox-seam.md`).
 *
 * Feature code imports `sandbox` from here and nothing else. Which runtime backs it is decided in
 * this file and only in this file — that is the whole point of the seam, and it is what turns the
 * §8 escape hatch from a paragraph into a one-line change plus a provider module.
 *
 * The shape (`Promise<T>` handed to store constructors) is unchanged from the WebContainer-only
 * design it replaces, so the migration of the stores is a type swap rather than a rewrite.
 *
 * ## Choosing a provider
 *
 * `VITE_SANDBOX_PROVIDER` switches the runtime at BUILD time. It is deliberately not a runtime
 * toggle: the providers have different lifecycles, different latency, and different costs, so a build
 * per target is honest where a live switch would invite mixing them in one session.
 *
 * 🔴 **It can only select a provider that `ENABLED_SANDBOX_PROVIDERS` allows — today, Nodepod alone.**
 * WebContainer and CodeSandbox are present, complete and dormant: unreachable by any configuration,
 * re-enabled only by editing that list (and the test pinning it). See `~/lib/common/sandbox-runtime.ts`.
 *
 * ⚠️ **`VITE_`-prefixed on purpose, and this is the one case where that is correct.** Vite inlines
 * every `VITE_*` variable into the client bundle, which is why the standing rule forbids the prefix
 * on secrets. The NAME of a runtime is not a secret — the client has to know which one to boot, and
 * it is plainly visible in the network traffic either way. `CODESANDBOX_API_KEY` stays unprefixed
 * and server-only, and `sandbox-seam.spec.ts` scans to prove it.
 */
import type { SandboxProvider } from './types';
import { SandboxProjectMismatchError, SandboxUnavailableError } from './errors';

export type * from './types';
export {
  describeSandboxFailure,
  SandboxAdoptionError,
  SandboxProjectMismatchError,
  SandboxUnavailableError,
} from './errors';

import {
  isSandboxProviderEnabled,
  resolveSandboxProviderId,
  SANDBOX_PROVIDER_TRAITS,
  type SandboxProviderId,
} from '~/lib/common/sandbox-runtime';

export type { SandboxProviderId } from '~/lib/common/sandbox-runtime';

/**
 * Which runtime this build uses. **Nodepod is the default** (`spec/sandbox-nodepod.md`).
 *
 * The id, the default, and every fact derived from it live in `~/lib/common/sandbox-runtime.ts` —
 * shared with `entry.server.tsx`, which needs the same answers and must not import this module (doing
 * so would pull a browser runtime, and its eager boot, into the server bundle).
 */
export const SANDBOX_PROVIDER: SandboxProviderId = resolveSandboxProviderId(
  import.meta.env.VITE_SANDBOX_PROVIDER,
  (message) => console.warn(message),
);

/**
 * Can the project's files survive this browser session?
 *
 * WebContainer's filesystem dies with the tab: close it, clear site data, or open the project on
 * another machine and the files are simply gone — so "it exists only in this browser tab" is literally
 * true, and the save nudges (§4.5.4b) say exactly that.
 *
 * A server-backed provider holds the files on a remote disk that outlives the page. The same sentence
 * there is FALSE, and a warning that says something the user can disprove ("I cleared my cache and my
 * game was still there") teaches them to ignore the next one — which is the one that matters, because
 * the conclusion has not changed: a sandbox VM is a workspace, not a backup. It can be reset,
 * reclaimed or replaced, the platform deliberately stores no project files (§4.5.4b), and the only
 * durable home for the user's game is their own repository.
 *
 * 🔴 Derived HERE rather than compared at the call site. `SANDBOX_PROVIDER === 'codesandbox'` scattered
 * through the UI means a third provider is durable-by-omission — it inherits WebContainer's copy and
 * tells its users their files vanish with the tab, silently and wrongly. Adding a provider must be a
 * deliberate answer to this question, in one place.
 */
export const SANDBOX_OUTLIVES_SESSION: boolean = SANDBOX_PROVIDER_TRAITS[SANDBOX_PROVIDER].outlivesSession;

/**
 * Does a boot on this provider need to know WHICH project it is for?
 *
 * WebContainer's runtime is a tab-local WASM VM with no server record and no identity — booting it
 * needs nothing, which is why it can still boot eagerly at module scope. A server-backed sandbox IS
 * the project's VM: its id lives on the project row (migration 0013), the session route resolves it
 * through `requireOwnedProject`, and there is literally no session to mint without a project id.
 *
 * Derived here for the same reason as {@link SANDBOX_OUTLIVES_SESSION}: a third provider must ANSWER
 * this question rather than inherit an answer by omission.
 */
export const SANDBOX_REQUIRES_PROJECT: boolean = SANDBOX_PROVIDER_TRAITS[SANDBOX_PROVIDER].requiresProject;

/**
 * The active sandbox for this tab, and the machinery that binds it to one project.
 *
 * 🔴 **Nothing here may run during SSR, and that is not obvious from reading it.** This module is
 * imported by the server render, so anything at module scope executes in Node — where a browser
 * runtime cannot exist and a relative `fetch('/api/...')` throws `ERR_INVALID_URL` and takes the
 * whole dev server down on boot.
 *
 * The WebContainer branch never needed a guard HERE because `~/lib/webcontainer` carries its own
 * (`if (!import.meta.env.SSR)`), handing back a never-resolving promise on the server. That made the
 * one-line CodeSandbox branch look equally safe when it was not: it inherited protection that lived
 * somewhere else entirely. **A pattern is only as safe as the thing it was copied from** — so the
 * guard is stated explicitly at this level now, where both branches can see it.
 *
 * A never-resolving promise is the right SSR value rather than a rejection: every consumer awaits
 * this in an effect or an event handler, none of which run during a server render, so "never" is
 * both accurate and silent. A rejection would surface as an unhandled error on every page load.
 *
 * 🔴 **`sandbox` is a DEFERRED promise now, and the shape of that promise is the compatibility
 * contract.** Stores capture it in their constructors (`filesStore`, `previewsStore`, the terminal
 * store…), so it must be one stable object created at module load — what changed is only WHEN it
 * resolves. It used to resolve because the module body booted a runtime immediately; on a
 * server-backed provider that is impossible, because a sandbox belongs to a PROJECT and no project id
 * exists at module-evaluation time. {@link bootForProject} supplies it from the mount path.
 */
interface BootState {
  /** The one promise every store captured. Resolved ONCE, by the first boot that succeeds. */
  sandbox: Promise<SandboxProvider>;
  resolve: (provider: SandboxProvider) => void;

  /** Set once a boot has succeeded — the tab is now bound to this provider and this project. */
  provider?: SandboxProvider;
  projectId?: string;

  /** A boot in progress. Concurrent callers for the same project join it rather than forking a VM. */
  inFlight?: Promise<SandboxProvider>;
  inFlightProjectId?: string;
}

function createBootState(): BootState {
  let resolve!: (provider: SandboxProvider) => void;

  /*
   * Deliberately a promise that only ever RESOLVES, never rejects. A failed boot is reported to the
   * caller of `bootForProject`, which can show it and offer a retry; rejecting this one would poison
   * the value every store is already holding, permanently, and the only cure would be a page reload —
   * which is exactly the behaviour the deferred boot exists to remove. On the server it simply stays
   * pending forever, which is correct: no consumer awaits it during a render.
   */
  const sandbox = new Promise<SandboxProvider>((r) => {
    resolve = r;
  });

  return { sandbox, resolve };
}

/*
 * ⚠️ Cached in `import.meta.hot.data` alongside the runtime it wraps. The provider object is
 * stateless, so a duplicate would not corrupt anything — but stores capture this promise in their
 * constructors, and a module reload that handed out a second identity would make
 * `filesStore.sandbox !== previewsStore.sandbox` in dev only, which is exactly the kind of
 * works-in-prod-fails-locally difference that costs an afternoon. The whole STATE is cached, not just
 * the promise, so a reload also remembers which project this tab is bound to.
 */
const state: BootState = import.meta.hot?.data.sandboxBoot ?? createBootState();

if (import.meta.hot) {
  import.meta.hot.data.sandboxBoot = state;
}

export const sandbox: Promise<SandboxProvider> = state.sandbox;

/** Which project this tab's sandbox is connected to, or `undefined` if nothing has booted yet. */
export function bootedProjectId(): string | undefined {
  return state.projectId ?? state.inFlightProjectId;
}

/**
 * The sandbox, or a described refusal if this page has none and cannot get one.
 *
 * 🔴 For the callers that await the seam OUTSIDE a project — importing a git repo or a local folder
 * from the landing page. On WebContainer they are unaffected: that runtime boots eagerly and needs no
 * project, so this is `sandbox` verbatim. On a server-backed provider there is genuinely nothing to
 * write into until a project exists, and `sandbox` is a promise that will simply never resolve — so
 * awaiting it bare turns "this flow needs a project first" into a spinner that runs forever with no
 * error, which is the worst available answer.
 *
 * ⚠️ This makes the failure HONEST; it does not make the flow work. Import-into-a-new-project on a
 * server sandbox needs the project registered first (the shape `createProjectFromRegistry` now has) —
 * tracked as T3b in `_specs/codesandbox-production_plan.md`. Until then these paths refuse with a
 * sentence rather than hanging. They used to "work" on that provider only by adopting whichever VM the
 * per-user registry handed back, which is precisely the cross-project defect T2 removed.
 */
export function requireBootedSandbox(): Promise<SandboxProvider> {
  if (SANDBOX_REQUIRES_PROJECT && !state.provider && !state.inFlight) {
    return Promise.reject(
      new SandboxUnavailableError('Open or create a project first — this workspace runtime needs one.', {
        retryable: false,
      }),
    );
  }

  /*
   * 🔴 `state.inFlight` FIRST, and this is not a micro-optimisation. `state.sandbox` only ever
   * RESOLVES — that is what makes a failed boot retryable for the stores holding it — so handing it
   * back while a boot is in flight means that if THAT boot fails, this caller waits forever. Which is
   * the exact hang this function exists to remove, reintroduced one branch to the left. The in-flight
   * promise rejects, so the caller learns.
   */
  return state.inFlight ?? state.sandbox;
}

/**
 * Can this tab's runtime load a compiled native addon? See `SandboxCapabilities.nativeAddons`.
 *
 * A helper rather than three copies of `(await …).capabilities.nativeAddons`, because the three
 * import paths (folder, git clone, snapshot restore) must not be able to answer this differently.
 *
 * **Never throws, and its failure answer is `true`** — i.e. "assume the runtime is fine". The only
 * consumer adds a ~10MB WASM binding to an install when this is false, so guessing `false` on a
 * sandbox we could not ask about would spend a download on every import for a runtime that never
 * needed one. `true` is the no-op, which is the correct thing to do when you do not know.
 *
 * 🔴 **It must never await `state.sandbox`, which only ever RESOLVES.** The obvious one-liner here
 * was `(await requireBootedSandbox()).capabilities.nativeAddons`, and on a runtime that needs no
 * project (WebContainer) that returns the shared promise — which stays pending forever if nothing
 * has booted. So a rendering hint would have hung an import indefinitely, with no error: MEASURED,
 * as two spec files going from milliseconds to a 30s and a 115s timeout. Same trap
 * `requireBootedSandbox` documents one function up, reached through its other branch. Only an
 * already-booted provider, or a boot genuinely in flight (that promise DOES reject), is awaited.
 */
export async function runtimeSupportsNativeAddons(): Promise<boolean> {
  try {
    const provider = state.provider ?? (state.inFlight ? await state.inFlight : undefined);

    return provider ? provider.capabilities.nativeAddons : true;
  } catch {
    return true;
  }
}

/**
 * Evaluate the chosen provider's modules and connect.
 *
 * 🔴 **BOTH branches are dynamic imports, and that is load-bearing — not a bundling nicety.**
 * `~/lib/webcontainer` BOOTS THE CONTAINER AS AN IMPORT SIDE EFFECT: the module body runs
 * `WebContainer.boot()` under its own `!import.meta.env.SSR` guard, so merely naming it at the top of
 * this file starts a runtime we may have decided not to use. Measured with
 * `VITE_SANDBOX_PROVIDER=codesandbox`: the browser downloaded StackBlitz's WASM bundles
 * (`w-credentialless-staticblitz.com/*.wasm`) and booted a WebContainer that nothing would ever
 * read — on every page load, alongside the CodeSandbox connection. Two runtimes, one used.
 *
 * A static import is a *decision to run* that module, and a ternary below it cannot undo one. So the
 * chosen provider is the only one whose module is ever evaluated, and neither vendor is a download
 * cost for a build that does not use it.
 */
async function connectProvider(projectId?: string): Promise<SandboxProvider> {
  /*
   * 🔴 **THE SECOND WALL, AND IT IS BEFORE ANY IMPORT.** `resolveSandboxProviderId` already refuses a
   * disabled provider, so in the ordinary path `SANDBOX_PROVIDER` can only be an enabled one — but
   * that resolver is a pure function, and the thing it protects is a LICENCE (WebContainers is
   * proprietary, `spec/licensing.md`) and a per-VM-hour bill. A future call site that computes the id
   * some other way, or a hand-edit during debugging, must not be able to reach a vendor runtime.
   *
   * Placed above the branches on purpose: refusing here means the disabled provider's module is never
   * evaluated, so there is no StackBlitz WASM download and no VM mint — the refusal is the same shape
   * as the dynamic imports themselves, where "do not import it" is the enforcement rather than a
   * ternary after the fact.
   */
  if (!isSandboxProviderEnabled(SANDBOX_PROVIDER)) {
    throw new SandboxUnavailableError(`The "${SANDBOX_PROVIDER}" workspace runtime is disabled in this build.`, {
      retryable: false,
    });
  }

  if (SANDBOX_PROVIDER === 'codesandbox') {
    const [boot, provider] = await Promise.all([import('./codesandbox-boot'), import('./codesandbox-provider')]);
    const connected = await boot.bootCodeSandbox(projectId!, {
      /*
       * A refused reconnect (`SandboxAdoptionError`) is invisible otherwise — the SDK turns it into a
       * connection that simply stops working. Reported through the shared notifier so the user is
       * told the workspace was replaced and that a reload is the way forward, rather than watching a
       * frozen workbench.
       */
      onAdoptionRefused: (error) => notifySandboxFailure(error),
    });

    return provider.createCodeSandboxProvider(connected.client, {
      previewUrl: connected.mintPreviewUrl,

      /*
       * The re-mint half (T8). A preview token dies after `CODESANDBOX_HOST_TOKEN_MINUTES` and the
       * iframe becomes a 401 page that still fires `onLoad` — so nothing notices unless the store can
       * ask for a fresh URL before expiry. Wiring it here is what makes `refreshPreviewUrl` exist on
       * this provider at all.
       */
      previewUrlForPort: connected.previewUrlForPort,

      // Per-BOOT, read from the session that produced this client — never module state (see the boot module).
      bootRestoredFilesystem: connected.bootRestoredFilesystem,
    });
  }

  if (SANDBOX_PROVIDER === 'nodepod') {
    const [boot, provider] = await Promise.all([import('./nodepod-boot'), import('./nodepod-provider')]);
    const connected = await boot.bootNodepod();

    return provider.createNodepodProvider(connected.client, {
      workdir: boot.NODEPOD_WORKDIR,
      onServerReady: connected.onServerReady,
    });
  }

  const [boot, provider] = await Promise.all([import('~/lib/webcontainer'), import('./webcontainer-provider')]);

  return provider.createWebContainerProvider(await boot.webcontainer);
}

/** How a boot failure reaches a person. Set by the UI; a no-op keeps this module free of React. */
let notifySandboxFailure: (error: Error) => void = () => {
  /* Until the UI registers one, a failure is reported by whoever awaited the boot. */
};

export function onSandboxFailure(notify: (error: Error) => void): void {
  notifySandboxFailure = notify;
}

/**
 * Boot the sandbox for a PROJECT, or join the boot already running for it.
 *
 * 🔴 This is the whole reason the eager module-scope boot had to go. A server-backed sandbox belongs
 * to a project, and at module-evaluation time no project id exists yet — it only lands during the
 * mount path (or, on creation, after the project is registered with the platform). So the boot is
 * DEFERRED and the seam's promise is a deferred one, while `sandbox` keeps the exact contract stores
 * were written against.
 *
 * Idempotent and safe to call on every mount:
 *
 *   - already booted for this project → the live provider;
 *   - a boot in flight for this project → that same boot (never a second VM);
 *   - already bound to a DIFFERENT project → `SandboxProjectMismatchError`. One tab holds one
 *     connection, because the stores captured one promise; the dashboard performs a full page load
 *     when `bootedProjectId()` disagrees, which is what makes A→B→A in one tab correct instead of
 *     merely quiet.
 *
 * A rejection is NOT cached. The previous design put the boot in a module-level promise, so the
 * server's deliberately-retryable 503 was terminal in the client: the only recovery was a page
 * reload. Here a failed attempt clears itself and the next call tries again.
 */
export function bootForProject(projectId?: string): Promise<SandboxProvider> {
  if (import.meta.env.SSR) {
    // Nothing boots during a server render; the never-resolving promise is the honest value.
    return state.sandbox;
  }

  if (state.provider) {
    if (SANDBOX_REQUIRES_PROJECT && projectId && state.projectId !== projectId) {
      return Promise.reject(new SandboxProjectMismatchError(state.projectId, projectId));
    }

    return Promise.resolve(state.provider);
  }

  if (state.inFlight) {
    if (SANDBOX_REQUIRES_PROJECT && projectId && state.inFlightProjectId !== projectId) {
      return Promise.reject(new SandboxProjectMismatchError(state.inFlightProjectId, projectId));
    }

    return state.inFlight;
  }

  if (SANDBOX_REQUIRES_PROJECT && !projectId) {
    /*
     * Refused rather than booted "for nobody". There is no session to mint without a project, and a
     * placeholder would have to invent one — which on this provider means someone else's VM.
     */
    return Promise.reject(
      new SandboxUnavailableError('A project is required to open a workspace on this runtime.', { retryable: false }),
    );
  }

  state.inFlightProjectId = projectId;

  const attempt = connectProvider(projectId).then(
    (provider) => {
      state.provider = provider;
      state.projectId = projectId;
      state.inFlight = undefined;
      state.resolve(provider);

      /*
       * 🔴 The dev-tools channel (`lib/preview/protocol.ts`), installed for EVERY provider that can
       * take it — this used to happen inside `webcontainer/index.ts`, so on the shipped default a
       * game that crashed at runtime reported nothing at all.
       *
       * Fire-and-forget, and deliberately AFTER `state.resolve`: this is instrumentation, and a
       * sandbox must never fail to open because its debugger could not be installed. `installPreviewAgent`
       * already reports rather than throws; the `.catch` covers the dynamic import itself.
       */
      void import('~/lib/preview/install')
        .then((module) => module.installPreviewDevTools(provider))
        .catch(() => {
          /* Reported inside the module; a missing debugger is never worth failing a boot for. */
        });

      return provider;
    },
    (error) => {
      state.inFlight = undefined;
      state.inFlightProjectId = undefined;

      throw error;
    },
  );

  state.inFlight = attempt;

  // The caller owns reporting this. Swallowed HERE only so a handled failure is not also an unhandled one.
  attempt.catch(() => {
    /* Deliberately empty: `attempt` is returned below and the caller's own catch is the real handler. */
  });

  return attempt;
}

/*
 * WebContainer needs no project, so it keeps booting eagerly — the behaviour that provider has always
 * had, unchanged, including the SSR guard inside `~/lib/webcontainer` itself.
 */
if (!import.meta.env.SSR && !SANDBOX_REQUIRES_PROJECT) {
  void bootForProject();
}
