export interface TarballCache {
    get(url: string): Promise<ArrayBuffer | null>;
    put(url: string, bytes: ArrayBuffer, integrity?: string): Promise<void>;
    prune(maxBytes?: number, maxAgeMs?: number): Promise<void>;
    clear(): Promise<void>;
    close(): void;
}
export declare function openTarballCache(): Promise<TarballCache | null>;
export declare function getTarballCache(): Promise<TarballCache | null>;
