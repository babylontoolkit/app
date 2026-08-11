declare const PRECOMPILE_THRESHOLD: number;
export declare function registerCompiledModule(bytes: Uint8Array, module: WebAssembly.Module): void;
export declare function precompileWasm(bytes: Uint8Array | ArrayBuffer): void;
export declare function getCachedModule(bytes: BufferSource): WebAssembly.Module | null;
export declare function compileWasmInWorker(bytes: Uint8Array | ArrayBuffer): Promise<WebAssembly.Module>;
export declare function needsAsyncCompile(bytes: BufferSource): boolean;
export declare function wasmCacheStats(): {
    entries: number;
    pending: number;
};
/** Drop only completed, reproducible modules. In-flight compiles stay live. */
export declare function reclaimWasmCache(): void;
export declare function disposeWasmCache(): void;
export { PRECOMPILE_THRESHOLD };
