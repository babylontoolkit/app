import type { CompletedResponse } from "./polyfills/http";
import { Server } from "./polyfills/http";
import { EventEmitter } from "./polyfills/events";
import { NodepodSWSetupError } from "./integrations/shared/errors";
export { NodepodSWSetupError };
export type { NodepodSWFrameworkHint } from "./integrations/shared/errors";
/** used by legacy zero-arg callers (createWorkspace, setServerListenCallback).
 *  multi-tenant callers pass their own instanceId */
export declare const DEFAULT_INSTANCE = "default";
export interface IVirtualServer {
    listening: boolean;
    address(): {
        port: number;
        address: string;
        family: string;
    } | null;
    dispatchRequest(method: string, url: string, headers: Record<string, string>, body?: Buffer | string): Promise<CompletedResponse>;
}
export interface RegisteredServer {
    server: Server | IVirtualServer;
    port: number;
    hostname: string;
}
export interface ProxyOptions {
    baseUrl?: string;
    onServerReady?: (port: number, url: string) => void;
}
export interface ServiceWorkerConfig {
    swUrl?: string;
    /**
     * Skip the HEAD preflight that checks /__sw__.js is served as JS.
     * Opt in if your host blocks HEAD, needs auth, or otherwise trips the probe.
     */
    skipPreflight?: boolean;
}
export { CompletedResponse };
type HandleRequestOptions = {
    /** when true, skip merging the local cookie jar into headers — SW
     *  requests already carry the authoritative jar from proxyToVirtualServer */
    skipCookieInject?: boolean;
};
export declare class RequestProxy extends EventEmitter {
    static DEBUG: boolean;
    private baseUrl;
    private opts;
    private channel;
    private swReady;
    private heartbeat;
    private _swAuthToken;
    /** memoizes concurrent initServiceWorker() callers so N parallel boots
     *  don't kick off N registrations that hang Chromium */
    private _swInitPromise;
    /** global, not per-instance. last writer wins across tabs */
    private _watermarkEnabled;
    /** guards pagehide/beforeunload listener registration so reinit doesn't stack them */
    private _farewellInstalled;
    /** server-registered etc. that fire before swReady; flushed once the port is up */
    private _pendingSwMessages;
    private _instances;
    private _wsBridge;
    /** In-memory cookie jar for virtual dev-server origins. Browsers ignore
     *  Set-Cookie on synthetic SW responses, so we replay Cookie headers here. */
    private _cookieJar;
    constructor(opts?: ProxyOptions);
    /** Update the origin used by `serverUrl()` / `onServerReady` (e.g. Node local HTTP). */
    setBaseUrl(url: string): void;
    getBaseUrl(): string;
    /** True after a successful Service Worker registration. */
    get isServiceWorkerReady(): boolean;
    private _getOrCreateInstance;
    /** attach a Nodepod to this proxy. idempotent: re-attaching with the same
     *  id rewires the process manager but keeps registry/preview script etc */
    attach(instanceId: string, processManager: any): void;
    /** detach an instance, unregister all its servers and tear down its ws
     *  connections. safe on an unknown id */
    detach(instanceId: string): void;
    /** @deprecated use attach(instanceId, pm). legacy callers route to DEFAULT_INSTANCE */
    setProcessManager(pm: any): void;
    register(instanceId: string, server: Server | IVirtualServer, port: number, hostname?: string): void;
    register(server: Server | IVirtualServer, port: number, hostname?: string): void;
    unregister(instanceId: string, port: number): void;
    unregister(port: number): void;
    private _extractSetCookie;
    private _storeResponseCookies;
    private _injectVirtualCookies;
    setPreviewScript(instanceId: string, script: string | null): void;
    setPreviewScript(script: string | null): void;
    setPreviewInspectorScript(instanceId: string, script: string | null): void;
    setWatermark(enabled: boolean): void;
    private _sendPreviewScriptToSW;
    private _sendPreviewInspectorScriptToSW;
    private _sendWsTokenToSW;
    serverUrl(instanceId: string, port: number): string;
    serverUrl(port: number): string;
    /** ports registered with the given instance. no arg returns the union
     *  across all instances (flat-list back-compat) */
    activePorts(instanceId?: string): number[];
    handleRequest(instanceId: string, port: number, method: string, url: string, headers: Record<string, string>, body?: ArrayBuffer, options?: HandleRequestOptions): Promise<CompletedResponse>;
    handleRequest(port: number, method: string, url: string, headers: Record<string, string>, body?: ArrayBuffer, options?: HandleRequestOptions): Promise<CompletedResponse>;
    private _preflightServiceWorker;
    /** concurrent callers share one in-flight promise, stops the Chromium
     *  SW-registration storm when N Nodepods boot in parallel.
     *
     *  NOT async on purpose. an async wrapper would create a fresh outer
     *  promise per call, so N callers each get their own identity and a
     *  .catch() on the inner shared promise wouldn't reach them, causing
     *  unhandled rejection warnings. returning the memoized promise directly
     *  means all callers share one object */
    initServiceWorker(config?: ServiceWorkerConfig): Promise<void>;
    private _doInitServiceWorker;
    private _normalizeSwUrl;
    private onSWMessage;
    private handleStreaming;
    /** mint a ws bridge token if the instance doesn't have one yet */
    private _ensureWsTokenForInstance;
    private _startWsBridge;
    private _handleWsConnect;
    private _handleWorkerWsFrame;
    private _handleWsSend;
    private _handleWsClose;
    private notifySW;
    private _flushPendingSwMessages;
    /** replay live server-registered messages after sw-ready or controllerchange reinit. */
    private _replayServerRegistrationsToSW;
    createFetchHandler(): (req: Request) => Promise<Response>;
}
export declare function getProxyInstance(opts?: ProxyOptions): RequestProxy;
export declare function resetProxy(): void;
export default RequestProxy;
