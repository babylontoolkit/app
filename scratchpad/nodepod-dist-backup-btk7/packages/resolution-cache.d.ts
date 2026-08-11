import type { ResolvedDependency } from "./version-resolver";
export declare function resolveWithCache(key: string, resolver: () => Promise<Map<string, ResolvedDependency>>): Promise<{
    tree: Map<string, ResolvedDependency>;
    hit: boolean;
}>;
export declare function clearResolutionMemoryCache(): void;
