import { type Handle } from "../helpers/event-loop";
declare const _rawSetTimeout: typeof globalThis.setTimeout;
/** Cancel every tracked timer. Called from child_process cleanup on exit/abort. */
export declare function disposeAllTimers(): void;
export interface TimeoutLike {
    _id: ReturnType<typeof _rawSetTimeout>;
    _handle: Handle;
    _isInterval: boolean;
    _fired: boolean;
    ref(): TimeoutLike;
    unref(): TimeoutLike;
    hasRef(): boolean;
    refresh(): TimeoutLike;
    [Symbol.toPrimitive](): number;
}
export declare function setTimeout(callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]): TimeoutLike;
export declare function setInterval(callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]): TimeoutLike;
export declare function setImmediate(callback: (...args: unknown[]) => void, ...args: unknown[]): TimeoutLike;
export declare function clearTimeout(t: unknown): void;
export declare function clearInterval(t: unknown): void;
export declare function clearImmediate(t: unknown): void;
export declare const promises: {
    setTimeout: (ms: number, value?: unknown, opts?: {
        signal?: AbortSignal;
    }) => Promise<unknown>;
    setInterval: (ms?: number, value?: unknown, opts?: {
        signal?: AbortSignal;
    }) => {
        [Symbol.asyncIterator](): AsyncIterator<unknown>;
    };
    setImmediate: (value?: unknown, opts?: {
        signal?: AbortSignal;
    }) => Promise<unknown>;
    scheduler: {
        wait: (ms: number) => Promise<unknown>;
    };
};
declare const _default: {
    setTimeout: typeof setTimeout;
    setInterval: typeof setInterval;
    setImmediate: typeof setImmediate;
    clearTimeout: typeof clearTimeout;
    clearInterval: typeof clearInterval;
    clearImmediate: typeof clearImmediate;
    promises: {
        setTimeout: (ms: number, value?: unknown, opts?: {
            signal?: AbortSignal;
        }) => Promise<unknown>;
        setInterval: (ms?: number, value?: unknown, opts?: {
            signal?: AbortSignal;
        }) => {
            [Symbol.asyncIterator](): AsyncIterator<unknown>;
        };
        setImmediate: (value?: unknown, opts?: {
            signal?: AbortSignal;
        }) => Promise<unknown>;
        scheduler: {
            wait: (ms: number) => Promise<unknown>;
        };
    };
};
export default _default;
