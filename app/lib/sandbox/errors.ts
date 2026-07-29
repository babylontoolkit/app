/**
 * The named failures of the sandbox seam (SPEC §8, `spec/sandbox-codesandbox.md`).
 *
 * Their own module rather than living beside the code that throws them, for one structural reason:
 * `index.ts` must be able to name them WITHOUT importing `codesandbox-boot.ts`, whose module body
 * statically imports `@codesandbox/sdk/browser`. A static import there would pull the vendor into a
 * WebContainer build — the exact "a static import is a decision to run that module" trap the seam
 * entry's own doc comment warns about, one layer down.
 *
 * All three are LOUD by design. A sandbox that cannot start, a tab that reconnected to the wrong
 * filesystem, and a boot asked for a project it is not bound to are each the whole product not
 * working; the failure mode of guessing is silent data loss, so each one is a described state a
 * caller can render.
 */

/** The sandbox could not be started or reached at all — "not configured", 503, network. */
export class SandboxUnavailableError extends Error {
  /** Whether trying again could plausibly work. Drives the boot screen's retry affordance. */
  readonly retryable: boolean;

  constructor(message: string, options: { retryable?: boolean } = {}) {
    super(message);
    this.name = 'SandboxUnavailableError';
    this.retryable = options.retryable ?? true;
  }
}

/**
 * A boot was requested for a project other than the one this tab is already bound to.
 *
 * One tab holds ONE sandbox connection: the seam hands every store a single `Promise<SandboxProvider>`
 * captured in their constructors, so there is no way to re-point them at a second VM mid-page without
 * every store silently continuing to talk to the first one. Switching projects is therefore a page
 * load, and the dashboard performs one rather than an SPA navigation (see `bootedProjectId`).
 */
export class SandboxProjectMismatchError extends Error {
  constructor(
    readonly bootedProjectId: string | undefined,
    readonly requestedProjectId: string,
  ) {
    super(
      `This tab's workspace is already connected to another project. Reload the page to open ${requestedProjectId}.`,
    );
    this.name = 'SandboxProjectMismatchError';
  }
}

/**
 * A RECONNECT came back pointing at a different sandbox than the one this page booted.
 *
 * 🔴 The dangerous direction, and the reason this is an error rather than a shrug: the SDK's
 * `getSession` is called to re-establish a dropped socket, and whatever session it is handed is what
 * the live client then talks to. If the server had to CREATE a VM (the previous one was deleted,
 * or its snapshot expired past recovery), reconnecting silently would swap the user's filesystem for
 * a bare template mid-session — every file gone, no event, no error, the workbench still rendering
 * the old tree from memory. Failing the reconnect leaves the connection dead and says so, which is
 * recoverable; adopting is not.
 */
export class SandboxAdoptionError extends Error {
  constructor(
    readonly bootedSandboxId: string,
    readonly offeredSandboxId: string,
  ) {
    super(
      'Your workspace was replaced while this tab was disconnected. Reload the page to open the new one — ' +
        'this tab will not write to it.',
    );
    this.name = 'SandboxAdoptionError';
  }
}

/**
 * Is this failure the SANDBOX failing, and if so what should the user be told?
 *
 * `undefined` for anything else, and that distinction is the point: a mount can fail for a dozen
 * reasons (a repo fetch, IndexedDB, a bad checkpoint) and most of them leave a usable workbench, so
 * they must keep landing on the ordinary "warn and carry on" path. Only a sandbox that never started
 * is worth replacing the whole screen with a failure surface — there is nothing behind it to use.
 *
 * Pure, because the alternative is an `instanceof` chain inlined at each call site, and a boot screen
 * that shows the wrong thing is a defect nobody would ever see in a stack trace.
 */
export function describeSandboxFailure(error: unknown): { message: string; retryable: boolean } | undefined {
  if (error instanceof SandboxUnavailableError) {
    return { message: error.message, retryable: error.retryable };
  }

  if (error instanceof SandboxProjectMismatchError || error instanceof SandboxAdoptionError) {
    /*
     * Not retryable in place: both mean this tab is bound to a sandbox that is not the one being asked
     * for, and no amount of retrying re-points the stores that already captured it. A reload is the
     * honest instruction, and it is in the message.
     */
    return { message: error.message, retryable: false };
  }

  return undefined;
}
