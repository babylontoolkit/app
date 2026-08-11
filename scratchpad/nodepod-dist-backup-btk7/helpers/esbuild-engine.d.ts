export type EsbuildEngine = typeof import("esbuild-wasm");
/**
 * Get (initializing on first call) the realm-wide esbuild-wasm instance.
 * A host page may pre-provide its own instance on `globalThis.__esbuild`.
 * Failed initialization clears the shared promise so callers can retry.
 */
export declare function getEsbuild(opts?: {
    wasmURL?: string;
}): Promise<EsbuildEngine>;
/** The initialized instance, or null if init hasn't completed yet. */
export declare function getEsbuildIfReady(): EsbuildEngine | null;
export declare function disposeEsbuild(): void;
