import type { RuntimeHost } from "./types";
/** Used by the browser entry / browser-host to register a lazy default. */
export declare function registerDefaultHostFactory(factory: (() => RuntimeHost) | null): void;
/** Install a runtime host (browser default, or Node via `@scelar/nodepod/headless`). */
export declare function setRuntimeHost(host: RuntimeHost): void;
export declare function getRuntimeHost(): RuntimeHost;
/**
 * Resolve a RuntimeHost after async chunk init. `vite-plugin-top-level-await`
 * wraps chunks in async IIFEs, so browser-host's
 * `globalThis.__NODEPOD_CREATE_BROWSER_HOST__ = ...` can land a tick after
 * static imports finish. Headless callers that already `setRuntimeHost` return
 * immediately.
 */
export declare function ensureRuntimeHost(): Promise<RuntimeHost>;
/** Reset the active host instance (tests). */
export declare function resetRuntimeHost(): void;
