import type { MemoryVolume } from "../memory-volume";
/**
 * Map a VFS path like `/project/node_modules/@scope/pkg/file.wasm` to its
 * jsdelivr URL, using the installed package.json version when available.
 * Returns null if the path isn't a node_modules .wasm path.
 */
export declare function buildCdnWasmUrl(volume: MemoryVolume, vfsPath: string): string | null;
export declare function isRecoverableWasmPath(vfsPath: unknown): vfsPath is string;
/**
 * Fetch a missing node_modules .wasm from the CDN, write it to the VFS, and
 * warm the compile caches. Deduplicated per path; never throws.
 */
export declare function prefetchWasmFromCdn(volume: MemoryVolume, vfsPath: string): Promise<boolean>;
