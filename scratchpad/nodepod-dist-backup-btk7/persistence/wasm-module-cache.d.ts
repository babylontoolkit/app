export interface WasmModuleCache {
    get(hash: string): Promise<WebAssembly.Module | null>;
    put(hash: string, module: WebAssembly.Module): Promise<void>;
    close(): void;
}
export declare function quickWasmHash(bytes: Uint8Array): string;
export declare function wasmContentHash(bytes: Uint8Array): Promise<string>;
export declare function getWasmModuleCache(): Promise<WasmModuleCache | null>;
/** Test hook: reset the singleton so a fresh environment can be simulated. */
export declare function __resetWasmModuleCacheForTests(): void;
