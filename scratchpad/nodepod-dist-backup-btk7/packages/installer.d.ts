import { MemoryVolume } from "../memory-volume";
import { RegistryConfig } from "./registry-client";
import { ResolvedDependency } from "./version-resolver";
import type { PackageManifest } from "../types/manifest";
import type { IDBSnapshotCache } from "../persistence/idb-cache";
import { restoreBinarySnapshot } from "../persistence/binary-snapshot";
import type { PerformanceTracker } from "../performance-tracker";
/**
 * The node_modules snapshot cache key.
 *
 * ⚠️ `lockFingerprint` is an explicit PARAMETER, not something the caller folds into `raw`. An
 * earlier draft of this fix concatenated it (`manifestSnapshotKey(raw + " " + lock, flags)`), which
 * silently made every existing caller compute a DIFFERENT key for the same project — a cache that
 * never hits, which costs a full network install and shows up as nothing but slowness. A key derived
 * in two places by convention is a key that eventually disagrees with itself.
 *
 * Defaults to `""`, which is exactly right for a project with no lockfile.
 */
export declare function manifestSnapshotKey(raw: string, flags?: InstallFlags, lockFingerprint?: string): string;
export interface InstallFlags {
    registry?: string;
    persist?: boolean;
    persistDev?: boolean;
    withDevDeps?: boolean;
    withOptionalDeps?: boolean;
    onProgress?: (message: string) => void;
    /**
     * Module transform timing. Default is lazy: install only downloads and
     * extracts; the runtime module loader converts ESM/CJS on first require()
     * (and caches it). Pass "eager" (or the legacy `true`) to run esbuild over
     * every installed file at install time like before.
     */
    transformModules?: boolean | "eager";
    /** Prefer lockfile tarball URL + SRI for the root package being installed. */
    lockEntry?: {
        resolved?: string;
        integrity?: string;
    };
}
export declare function isEagerTransform(value: boolean | "eager" | undefined): boolean;
export declare function isManifestSnapshotComplete(snapshot: Parameters<typeof restoreBinarySnapshot>[1], workingDir: string, manifest: PackageManifest, flags?: InstallFlags): boolean;
export interface InstallOutcome {
    resolved: Map<string, ResolvedDependency>;
    newPackages: string[];
}
declare function splitSpecifier(spec: string): {
    name: string;
    version?: string;
};
export declare class DependencyInstaller {
    private vol;
    private registryClient;
    private workingDir;
    private _snapshotCache;
    private _performance;
    constructor(vol: MemoryVolume, opts?: {
        cwd?: string;
        snapshotCache?: IDBSnapshotCache | null;
        performanceTracker?: PerformanceTracker | null;
    } & RegistryConfig);
    install(packageName: string, version?: string, flags?: InstallFlags): Promise<InstallOutcome>;
    installFromManifest(manifestPath?: string, flags?: InstallFlags): Promise<InstallOutcome>;
    listInstalled(): Record<string, string>;
    private materializePackages;
    private createBinStubs;
    private writeLockFile;
    private patchManifest;
}
export declare function install(specifier: string, vol: MemoryVolume, flags?: InstallFlags): Promise<InstallOutcome>;
export { RegistryClient } from "./registry-client";
export type { RegistryConfig, VersionDetail, PackageMetadata, } from "./registry-client";
export type { ResolvedDependency, ResolutionConfig } from "./version-resolver";
export type { ExtractionOptions } from "./archive-extractor";
export { splitSpecifier };
