/**
 * Read the SW source. Pass `import.meta.url` from the caller so we can
 * resolve paths whether we're running from src/ or dist/.
 */
export declare function readServiceWorkerSource(fromFileUrl: string): Promise<string>;
/** Test-only: reset the module cache between cases. */
export declare function __resetServiceWorkerSourceCacheForTests(): void;
