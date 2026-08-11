/**
 * generic support for napi-rs WASM packages in nodepod
 *
 * every napi-rs v3 WASM package (targeting wasm32-wasip1-threads) ships a
 * wasi-worker.mjs that needs a real Web Worker so Atomics.wait() can block
 *
 * we:
 * 1. detect napi-rs WASI worker scripts
 * 2. bundle them + deps into self-contained blobs
 * 3. spawn real Web Workers wrapping the Node.js worker_threads API
 *
 * no hardcoding per package
 */
import type { MemoryVolume } from "../memory-volume";
/**
 * true if scriptPath is a wasi-worker script in a node_modules package that
 * also has a .wasm file next to it (i.e. an napi-rs WASM package)
 *
 * napi-rs generates these names: wasi-worker.mjs and wasi-worker-browser.mjs
 */
export declare function isNapiWasiWorkerScript(scriptPath: string, vol: MemoryVolume): boolean;
/**
 * builds a self-contained Web Worker script from a VFS entry point
 * recursively resolves imports/requires and inlines everything
 */
export declare function buildNapiWorkerBundle(entryPath: string, vol: MemoryVolume, resolveModule: (id: string, fromDir: string) => string, processEnv: Record<string, string>): string;
/**
 * makes a PatchedWorker constructor that spawns real browser Web Workers for
 * napi-rs WASI scripts, falling back to the standard fork-based worker otherwise
 */
export declare function createNapiWorkerFactory(vol: MemoryVolume, resolveModule: (id: string, fromDir: string) => string, processEnv: Record<string, string>, fsBridge: any, // for handling __fs__ proxy messages
fallbackWorkerFn: ((...args: any[]) => any) | null, sabEnabled: boolean): (this: any, script: string | URL, opts?: any) => void;
export declare function handleFsProxy(req: {
    sab: Int32Array;
    type: string;
    payload: any[];
    requestId?: number;
}, fsBridge: any): void;
