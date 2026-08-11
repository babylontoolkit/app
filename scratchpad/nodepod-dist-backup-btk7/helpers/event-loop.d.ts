declare const EXIT_SENTINEL_BRAND: unique symbol;
export declare class ProcessExitSentinel extends Error {
    readonly exitCode: number;
    readonly [EXIT_SENTINEL_BRAND]: true;
    constructor(code: number);
}
export declare function isExitSentinel(e: unknown): boolean;
export type HandleType = "Timeout" | "Immediate" | "Interval" | "FetchRequest" | "DynamicImport" | "TCPSocketWrap" | "TCPServerWrap" | "UDPWrap" | "PipeWrap" | "IPCChannel" | "TLSWrap" | "HTTP2Session" | "HTTPServer" | "FSReqCallback" | "FSWatcher" | "StatWatcher" | "WebSocket" | "MessagePort" | "BroadcastChannel" | "Worker" | "ChildProcess" | "TTYWrap" | "ReadlineInterface" | "EsbuildOp" | "WASMWork";
export interface Handle {
    readonly type: HandleType;
    readonly registry: HandleRegistry;
    readonly refed: boolean;
    readonly closed: boolean;
    ref(): this;
    unref(): this;
    close(): void;
}
export interface HandleRegistry {
    register(type: HandleType, opts?: {
        refed?: boolean;
    }): Handle;
    activeRefedCount(): number;
    list(): ReadonlyArray<Handle>;
    groupedByType(): Record<string, number>;
    /** Fresh promise each drain cycle. Resolves on refed-count 1 to 0. */
    drainPromise(): Promise<void>;
    onDrain(cb: () => void): () => void;
    /** Awaits each beforeExit handler sequentially. */
    emitBeforeExit(code: number): Promise<void>;
    onBeforeExit(cb: (code: number) => void | Promise<void>): () => void;
    closeAll(): void;
}
export declare function getRegistry(): HandleRegistry;
export declare function getGlobalRegistry(): HandleRegistry;
export declare function createHandleRegistry(): HandleRegistry;
export {};
