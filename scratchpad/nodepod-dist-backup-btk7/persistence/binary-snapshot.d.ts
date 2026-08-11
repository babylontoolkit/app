import type { MemoryVolume } from "../memory-volume";
import type { VFSBinarySnapshot } from "../threading/worker-protocol";
export declare function createFilteredBinarySnapshot(vol: MemoryVolume, filter: (path: string) => boolean): VFSBinarySnapshot;
export declare function restoreBinarySnapshot(vol: MemoryVolume, snapshot: VFSBinarySnapshot): number;
