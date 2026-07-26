/**
 * The sandbox entry point (SPEC §1.3.5, §8, `spec/sandbox-seam.md`).
 *
 * Feature code imports `sandbox` from here and nothing else. Which runtime backs it is decided in
 * this file and only in this file — that is the whole point of the seam, and it is what turns the
 * §8 escape hatch from a paragraph into a one-line change plus a provider module.
 *
 * The shape (`Promise<T>` handed to store constructors) is unchanged from the WebContainer-only
 * design it replaces, so the migration of the stores is a type swap rather than a rewrite.
 */
import { webcontainer } from '~/lib/webcontainer';
import type { SandboxProvider } from './types';
import { createWebContainerProvider } from './webcontainer-provider';

export type * from './types';

/**
 * The active sandbox for this session.
 *
 * ⚠️ Cached in `import.meta.hot.data` alongside the container it wraps. The provider object is
 * stateless, so a duplicate would not corrupt anything — but stores capture this promise in their
 * constructors, and a module reload that handed out a second identity would make
 * `filesStore.sandbox !== previewsStore.sandbox` in dev only, which is exactly the kind of
 * works-in-prod-fails-locally difference that costs an afternoon.
 */
export const sandbox: Promise<SandboxProvider> =
  import.meta.hot?.data.sandbox ?? webcontainer.then(createWebContainerProvider);

if (import.meta.hot) {
  import.meta.hot.data.sandbox = sandbox;
}
