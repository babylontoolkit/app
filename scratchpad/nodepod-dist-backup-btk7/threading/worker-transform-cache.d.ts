export declare class LruTransformCache {
    private _map;
    private _bytes;
    private readonly _maxEntries;
    private readonly _maxBytes;
    constructor(maxEntries?: number, maxBytes?: number);
    get(key: string): string | undefined;
    set(key: string, value: string): this;
    has(key: string): boolean;
    delete(key: string): boolean;
    clear(): void;
    get size(): number;
    stats(): {
        entries: number;
        approxBytes: number;
    };
    private _evict;
}
export declare function getWorkerTransformCache(): LruTransformCache;
