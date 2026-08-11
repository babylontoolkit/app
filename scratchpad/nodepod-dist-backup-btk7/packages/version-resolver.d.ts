import { RegistryClient } from "./registry-client";
export interface ResolvedDependency {
    name: string;
    /** Registry name used for fetch (differs from `name` for npm: aliases). */
    fetchName: string;
    version: string;
    tarballUrl: string;
    dependencies: Record<string, string>;
    shasum?: string;
    /** npm lockfile SRI (sha512-…) when installing from a lock entry */
    integrity?: string;
}
export interface ResolutionConfig {
    registry?: RegistryClient;
    devDependencies?: boolean;
    optionalDependencies?: boolean;
    onProgress?: (msg: string) => void;
    /**
     * Exact versions from `package-lock.json`, keyed by package name.
     *
     * A lockfile exists so that everyone installing a project gets the versions its authors actually
     * tested. Ignoring it and resolving ranges to whatever is newest today is not a smaller install —
     * it is a DIFFERENT project, and the failure is silent: everything installs, the app usually runs,
     * and the damage shows up somewhere unrelated.
     *
     * Measured 2026-08-03 on a real Vite + Babylon project: the lockfile pinned `@babylonjs/core`
     * 9.16.0 as a single hoisted copy, `^9.16.0` re-resolved to 9.19.0, and the toolkit's own pinned
     * 9.16.0 was then nested beneath it. Two copies of one library means two nominal TypeScript
     * identities, so `tsc` produced 33 `Type 'X' is not assignable to type 'X'` errors and the project
     * could no longer build — while `vite dev` ran fine, because it never typechecks.
     *
     * Advisory, not binding: a locked version is used only when it still satisfies the range in
     * `package.json`. If someone widened or bumped a dependency without refreshing the lock, the
     * manifest wins — matching npm, and keeping a stale lock from pinning a project to a version its
     * own manifest has already moved past.
     */
    lockedVersions?: ReadonlyMap<string, string>;
}
export interface SemverComponents {
    major: number;
    minor: number;
    patch: number;
    prerelease?: string;
}
export declare function parseSemver(raw: string): SemverComponents | null;
export declare function compareSemver(left: string, right: string): number;
export declare function satisfiesRange(version: string, range: string): boolean;
export declare function pickBestMatch(available: string[], range: string): string | null;
export declare function resolveDependencyTree(rootName: string, versionRange?: string, config?: ResolutionConfig): Promise<Map<string, ResolvedDependency>>;
export declare function resolveFromManifest(manifest: {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
}, config?: ResolutionConfig): Promise<Map<string, ResolvedDependency>>;
export declare class VersionResolver {
    parse: typeof parseSemver;
    compare: typeof compareSemver;
    satisfies: typeof satisfiesRange;
    pickBest: typeof pickBestMatch;
    resolveTree: typeof resolveDependencyTree;
    resolveManifest: typeof resolveFromManifest;
}
export default VersionResolver;
