import { MemoryVolume } from "../memory-volume";
import { DependencyInstaller } from "../packages/installer";
import { RequestProxy } from "../request-proxy";
import type { NodepodOptions, NodepodRequestOptions, TerminalOptions, Snapshot, SnapshotOptions, SpawnOptions } from "./types";
import { NodepodFS } from "./nodepod-fs";
import { NodepodProcess } from "./nodepod-process";
import { NodepodTerminal } from "./nodepod-terminal";
import { ProcessManager } from "../threading/process-manager";
import { NodepodFSClient } from "./nodepod-fs-client";
import type { CompletedResponse } from "../polyfills/http";
import { type PerformanceStats } from "../performance-tracker";
import { PreviewInspector } from "./preview-inspector";
export declare class Nodepod {
    readonly fs: NodepodFS;
    /** Opt-in inspection of a host-owned preview iframe. */
    readonly inspect: PreviewInspector;
    /** unique id used by RequestProxy + SW to route back to this Nodepod when
     *  multiple coexist on one page */
    readonly instanceId: string;
    private _volume;
    private _packages;
    private _proxy;
    private _cwd;
    private _env;
    private _processManager;
    private _vfsBridge;
    private _sharedVFS;
    private _syncChannel;
    private _unwatchVFS;
    private _handler;
    private _sabEnabled;
    private _sharedVFSBufferSize;
    private _disposed;
    private _unsubscribePressure;
    private _performance;
    private _httpIngress;
    private _headless;
    private constructor();
    static boot(opts?: NodepodOptions): Promise<Nodepod>;
    /** Whether this instance was booted in headless mode. */
    get isHeadless(): boolean;
    /**
     * Programmatic HTTP against a virtual server registered on this instance.
     * Works without Service Worker / preview iframes (headless-friendly).
     */
    request(port: number, init?: NodepodRequestOptions): Promise<CompletedResponse>;
    spawn(cmd: string, args?: string[], opts?: SpawnOptions): Promise<NodepodProcess>;
    private _resolveCommand;
    createTerminal(opts: TerminalOptions): NodepodTerminal;
    setPreviewScript(script: string): Promise<void>;
    clearPreviewScript(): Promise<void>;
    port(num: number): string | null;
    /** Directory names excluded from snapshots at any depth when shallow=true. */
    private static readonly SHALLOW_EXCLUDE_DIRS;
    snapshot(opts?: SnapshotOptions): Snapshot;
    restore(snapshot: Snapshot, opts?: SnapshotOptions): Promise<void>;
    teardown(): void;
    performanceStats(): PerformanceStats;
    memoryStats(): {
        vfs: {
            fileCount: number;
            totalBytes: number;
            dirCount: number;
            watcherCount: number;
            lazyResidentBytes: number;
        };
        engine: {
            moduleCacheSize: number;
            transformCacheSize: number;
        };
        runtime: {
            processes: number;
            workers: number;
            messagePorts: number;
            pendingHttp: number;
            sharedFSAllocated: boolean;
            sharedFSBytes: number;
            sharedFSUsedBytes: number;
            wasmCacheEntries: number;
            budgetMB: number;
        };
        heap: {
            usedMB: number;
            totalMB: number;
            limitMB: number;
        } | null;
    };
    /**
     * postMessage this to a sibling worker (one the host app spawned, not one
     * nodepod spawned via spawn()), then call Nodepod.attachFS(buffer) on the
     * other side. null if SAB is unavailable, but boot() would have thrown in
     * that case so this is mostly defensive.
     *
     * default capacity is 256 MiB (or sharedVFSBufferSize at boot), 65,536
     * entries, 248-byte paths. writes past either cap count as dropped writes
     * so callers can detect an undersized mirror.
     */
    get sharedFSBuffer(): SharedArrayBuffer | null;
    /**
     * attach to an existing nodepod from a sibling worker using the buffer
     * from nodepod.sharedFSBuffer. the returned client is read-only, writes
     * throw ENOTSUP.
     */
    static attachFS(buffer: SharedArrayBuffer): NodepodFSClient;
    get volume(): MemoryVolume;
    /** @deprecated Main-thread engine removed for security. all code now runs in isolated Web Workers via spawn() <-- this removes fatal security flaws. */
    get engine(): never;
    get packages(): DependencyInstaller;
    get proxy(): RequestProxy;
    get processManager(): ProcessManager;
    get cwd(): string;
    /** true if SAB features are active on this instance */
    get isSharedArrayBufferEnabled(): boolean;
    private _assertActive;
}
