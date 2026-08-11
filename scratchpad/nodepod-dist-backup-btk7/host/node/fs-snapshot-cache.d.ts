import type { IDBSnapshotCache } from "../../persistence/idb-cache";
/**
 * Disk-backed snapshot cache for Node headless — same interface as IDB/OPFS.
 * Layout: `{manifestLen:u32le}{manifestJson}{dataBytes}` plus a sibling `.meta.json`.
 */
export declare function openFsSnapshotCache(cacheDir?: string): Promise<IDBSnapshotCache | null>;
export declare function fsCacheStats(cacheDir?: string): Promise<{
    entries: number;
    bytes: number;
}>;
