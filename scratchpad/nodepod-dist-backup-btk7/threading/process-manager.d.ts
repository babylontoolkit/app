import { EventEmitter } from "../polyfills/events";
import type { MemoryVolume } from "../memory-volume";
import { ProcessHandle } from "./process-handle";
import type { ProcessInfo } from "./worker-protocol";
import type { VFSBridge } from "./vfs-bridge";
import type { PerformanceTracker } from "../performance-tracker";
export declare class ProcessManager extends EventEmitter {
    private _processes;
    private _nextPid;
    private _volume;
    private _performance;
    private _vfsBridge;
    private _syncBuffer;
    private _processPorts;
    private _wasiWorkers;
    private _nextWasiTid;
    private _serverPorts;
    private _childPids;
    private _inheritStdinChildren;
    private _httpCallbacks;
    private _nextHttpRequestId;
    private static readonly HTTP_REQUEST_TIMEOUT_MS;
    constructor(volume: MemoryVolume, performanceTracker?: PerformanceTracker | null);
    setVFSBridge(bridge: VFSBridge): void;
    setSyncBuffer(buf: SharedArrayBuffer): void;
    private _spawnSnapshotMode;
    private _warnedLeanUnavailable;
    setSpawnSnapshotMode(mode: "full" | "lean"): void;
    spawn(config: {
        command: string;
        args?: string[];
        cwd?: string;
        env?: Record<string, string>;
        parentPid?: number;
    }): ProcessHandle;
    private _isDependencyManagementCommand;
    getProcess(pid: number): ProcessHandle | undefined;
    listProcesses(): ProcessInfo[];
    kill(pid: number, signal?: string): boolean;
    private _cleanupServerPorts;
    private _killDescendants;
    teardown(): void;
    private _cleanupProcessResources;
    private _wasiWorkerKey;
    private _finishWasiWorker;
    get processCount(): number;
    registerServerPort(port: number, pid: number): void;
    unregisterServerPort(port: number): void;
    getServerPorts(): number[];
    dispatchHttpRequest(port: number, method: string, path: string, headers: Record<string, string>, body?: string | null): Promise<{
        statusCode: number;
        statusMessage: string;
        headers: Record<string, string | string[]>;
        body: string | ArrayBuffer;
    }>;
    private _handleWorkerHttpClientRequest;
    dispatchWsUpgrade(port: number, uid: string, path: string, headers: Record<string, string>): number;
    dispatchWsData(pid: number, uid: string, frame: number[]): void;
    dispatchWsClose(pid: number, uid: string, code: number): void;
    /**
     * Try to load the worker bundle from a same-origin asset
     * (dist/__worker__.js) so spawns don't need the embedded string copy.
     * Fire-and-forget from boot; until (and unless) it resolves, spawns use
     * the embedded bundle. Explicit `workerUrl` wins over auto-detection.
     */
    static probeExternalWorkerBundle(workerUrl?: string): Promise<void>;
    static disposeGlobalResources(): void;
    private _createWasiBootstrap;
    private _handleFsProxyWithRecovery;
    private _notifyDelegatedThread;
    private _spawnDelegatedWasiThread;
    resourceStats(): {
        processes: number;
        workers: number;
        messagePorts: number;
        pendingHttp: number;
    };
    private _createWorker;
    private _createEmbeddedWorker;
    private _wireHandleEvents;
    private static readonly SAB_STATUS_PENDING;
    private static readonly SAB_STATUS_OK;
    private static readonly SAB_STATUS_FAIL;
    private _handleSqlitePreload;
    private _createEmptySnapshot;
    private static readonly VFS_BROADCAST_MAX_BYTES;
    broadcastVFSChange(path: string, content: ArrayBuffer | null, isDirectory: boolean, excludePid: number): void;
}
