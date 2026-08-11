import type { VFSBinarySnapshot } from '../threading/worker-protocol';
export interface IDBSnapshotCache {
    get(packageJsonHash: string): Promise<VFSBinarySnapshot | null>;
    set(packageJsonHash: string, snapshot: VFSBinarySnapshot): Promise<void>;
    close(): void;
}
export declare function openSnapshotCache(): Promise<IDBSnapshotCache | null>;
