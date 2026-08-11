export interface DiagChannel {
    name: string;
    readonly hasSubscribers: boolean;
    subscribe(handler: (message: unknown, name: string) => void): void;
    unsubscribe(handler: (message: unknown, name: string) => void): boolean;
    publish(message: unknown): void;
}
export declare const DiagChannel: {
    new (name: string): DiagChannel;
    prototype: any;
};
export declare function channel(name: string): DiagChannel;
export declare function hasSubscribers(name: string): boolean;
export declare function subscribe(name: string, handler: (message: unknown, name: string) => void): void;
export declare function unsubscribe(name: string, handler: (message: unknown, name: string) => void): boolean;
export { DiagChannel as Channel };
export interface TracingChannelSubscribers {
    start?: (message: unknown, name: string) => void;
    end?: (message: unknown, name: string) => void;
    asyncStart?: (message: unknown, name: string) => void;
    asyncEnd?: (message: unknown, name: string) => void;
    error?: (message: unknown, name: string) => void;
}
export interface TracingChannelChannels {
    start: DiagChannel;
    end: DiagChannel;
    asyncStart: DiagChannel;
    asyncEnd: DiagChannel;
    error: DiagChannel;
}
export declare class TracingChannel implements TracingChannelChannels {
    start: DiagChannel;
    end: DiagChannel;
    asyncStart: DiagChannel;
    asyncEnd: DiagChannel;
    error: DiagChannel;
    constructor(nameOrChannels: string | TracingChannelChannels);
    get hasSubscribers(): boolean;
    subscribe(subscribers: TracingChannelSubscribers): void;
    unsubscribe(subscribers: TracingChannelSubscribers): boolean;
    traceSync<R>(fn: (...a: unknown[]) => R, context?: Record<string, unknown>, thisArg?: unknown, ...args: unknown[]): R;
    tracePromise<R>(fn: (...a: unknown[]) => Promise<R> | R, context?: Record<string, unknown>, thisArg?: unknown, ...args: unknown[]): Promise<R>;
    traceCallback<R>(fn: (...a: unknown[]) => R, position?: number, context?: Record<string, unknown>, thisArg?: unknown, ...args: unknown[]): R;
}
export declare function tracingChannel(nameOrChannels: string | TracingChannelChannels): TracingChannel;
declare const _default: {
    channel: typeof channel;
    hasSubscribers: typeof hasSubscribers;
    subscribe: typeof subscribe;
    unsubscribe: typeof unsubscribe;
    tracingChannel: typeof tracingChannel;
    Channel: {
        new (name: string): DiagChannel;
        prototype: any;
    };
    TracingChannel: typeof TracingChannel;
};
export default _default;
