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
 * `VITE_SANDBOX_PROVIDER=codesandbox` switches the runtime at BUILD time. It is deliberately not a
 * runtime toggle: the two providers have different lifecycles, different latency, and different
 * costs, so a build per target is honest where a live switch would invite mixing them in one
 * session.
 *
 * ⚠️ **`VITE_`-prefixed on purpose, and this is the one case where that is correct.** Vite inlines
 * every `VITE_*` variable into the client bundle, which is why the standing rule forbids the prefix
 * on secrets. The NAME of a runtime is not a secret — the client has to know which one to boot, and
 * it is plainly visible in the network traffic either way. `CODESANDBOX_API_KEY` stays unprefixed
 * and server-only, and `sandbox-seam.spec.ts` scans to prove it.
 */
import type { SandboxProvider } from './types';

export type * from './types';

export type SandboxProviderId = 'webcontainer' | 'codesandbox';

/**
 * Which runtime this build uses.
 *
 * Anything other than `codesandbox` — including unset, a typo, or a stale value — means
 * WebContainer. Defaulting to the incumbent is the safe direction: a mistyped variable produces the
 * behaviour the product already had, rather than a build that cannot open a project at all.
 */
export const SANDBOX_PROVIDER: SandboxProviderId =
  import.meta.env.VITE_SANDBOX_PROVIDER === 'codesandbox' ? 'codesandbox' : 'webcontainer';

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
export const SANDBOX_OUTLIVES_SESSION: boolean = SANDBOX_PROVIDER === 'codesandbox';

/**
 * The active sandbox for this session.
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
 * ⚠️ Cached in `import.meta.hot.data` alongside the runtime it wraps. The provider object is
 * stateless, so a duplicate would not corrupt anything — but stores capture this promise in their
 * constructors, and a module reload that handed out a second identity would make
 * `filesStore.sandbox !== previewsStore.sandbox` in dev only, which is exactly the kind of
 * works-in-prod-fails-locally difference that costs an afternoon.
 *
 * 🔴 **BOTH branches are dynamic imports, and that is load-bearing — not a bundling nicety.**
 * `~/lib/webcontainer` BOOTS THE CONTAINER AS AN IMPORT SIDE EFFECT: the module body runs
 * `WebContainer.boot()` under its own `!import.meta.env.SSR` guard, so merely naming it at the top
 * of this file starts a runtime we may have decided not to use. Measured with
 * `VITE_SANDBOX_PROVIDER=codesandbox`: the browser downloaded StackBlitz's WASM bundles
 * (`w-credentialless-staticblitz.com/*.wasm`) and booted a WebContainer that nothing would ever
 * read — on every page load, alongside the CodeSandbox connection. Two runtimes, one used.
 *
 * A static import is a *decision to run* that module, and a ternary below it cannot undo one. So the
 * chosen provider is the only one whose module is ever evaluated, and neither vendor is a download
 * cost for a build that does not use it.
 */
export let sandbox: Promise<SandboxProvider> = new Promise(() => {
  /* Never resolves: on the server there is no sandbox, and no consumer awaits this during a render. */
});

if (import.meta.hot?.data.sandbox) {
  sandbox = import.meta.hot.data.sandbox;
} else if (!import.meta.env.SSR) {
  sandbox =
    SANDBOX_PROVIDER === 'codesandbox'
      ? Promise.all([import('./codesandbox-boot'), import('./codesandbox-provider')]).then(([boot, provider]) =>
          boot.bootCodeSandbox().then((client) =>
            provider.createCodeSandboxProvider(client, {
              previewUrl: boot.mintPreviewUrl,

              // Read AFTER boot resolves — it is derived from the session response's bootupType.
              bootRestoredFilesystem: boot.bootRestoredFilesystem(),
            }),
          ),
        )
      : Promise.all([import('~/lib/webcontainer'), import('./webcontainer-provider')]).then(([boot, provider]) =>
          boot.webcontainer.then(provider.createWebContainerProvider),
        );
}

if (import.meta.hot) {
  import.meta.hot.data.sandbox = sandbox;
}
