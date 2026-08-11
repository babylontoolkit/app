/**
 * Read the worker bundle source, or null when the built asset isn't on disk.
 * Pass `import.meta.url` from the caller so paths resolve from src/ or dist/.
 */
export declare function readWorkerBundleSource(fromFileUrl: string): Promise<string | null>;
/** Test-only: reset the module cache between cases. */
export declare function __resetWorkerBundleSourceCacheForTests(): void;
