export interface PerformanceTiming {
    count: number;
    totalMs: number;
    lastMs: number;
    minMs: number;
    maxMs: number;
}
export interface PerformanceStats {
    timings: Record<string, PerformanceTiming>;
    counters: Record<string, number>;
}
export declare class PerformanceTracker {
    private readonly timings;
    private readonly counters;
    start(name: string): () => number;
    record(name: string, durationMs: number): void;
    increment(name: string, amount?: number): void;
    snapshot(): PerformanceStats;
    clear(): void;
}
