import type { MemoryVolume } from "../memory-volume";
import type { VFSBinarySnapshot, VFSSnapshotEntry } from "./worker-protocol";
import type { SharedVFSController } from "./shared-vfs";
export declare class VFSBridge {
    private _volume;
    private _broadcaster;
    private _sharedVFS;
    private _suppressWatch;
    private _warnedSharedVFSDrop;
    constructor(volume: MemoryVolume);
    setBroadcaster(fn: (path: string, content: ArrayBuffer | null, isDirectory: boolean, excludePid: number) => void): void;
    setSharedVFS(controller: SharedVFSController, hydrate?: boolean): void;
    clearSharedVFS(): void;
    private _hydrateSharedVFS;
    createSnapshot(opts?: {
        excludeDirNames?: string[];
    }): VFSBinarySnapshot;
    createChunkedSnapshots(): {
        chunkIndex: number;
        totalChunks: number;
        data: ArrayBuffer;
        manifest: VFSSnapshotEntry[];
    }[];
    handleWorkerWrite(path: string, content: Uint8Array): void;
    handleWorkerSnapshot(snapshot: VFSBinarySnapshot): void;
    private _sharedVFSWrite;
    private _sharedVFSWriteDirectory;
    private _warnSharedVFSDrop;
    handleWorkerMkdir(path: string): void;
    handleWorkerDelete(path: string): void;
    private _rmTree;
    broadcastChange(path: string, content: ArrayBuffer | null, isDirectory: boolean, excludePid: number): void;
    watch(): () => void;
    private _walkVolume;
}
