import type { MemoryVolume } from "../memory-volume";
import type { ShellContext, ShellResult } from "../shell/shell-types";
export type PkgManager = "npm" | "pnpm" | "yarn" | "bun";
export declare function hasGlobalFlag(args: string[]): boolean;
export declare function rejectGlobal(args: string[], pm: PkgManager): ShellResult | null;
export declare function readNpmrc(vol: MemoryVolume, cwd: string): Record<string, string>;
export declare function writeNpmrcKey(vol: MemoryVolume, cwd: string, key: string, value: string): void;
export declare function deleteNpmrcKey(vol: MemoryVolume, cwd: string, key: string): void;
export declare function resolveRegistry(vol: MemoryVolume, cwd: string, env: Record<string, string>): string;
export declare function resolveAuthToken(vol: MemoryVolume, cwd: string, env: Record<string, string>, registry: string): string | undefined;
export declare function npmConfig(vol: MemoryVolume, args: string[], ctx: ShellContext): ShellResult;
export declare function npmPkg(vol: MemoryVolume, args: string[], ctx: ShellContext): ShellResult;
export declare function clearPmCaches(): Promise<ShellResult>;
export declare function npmPing(vol: MemoryVolume, ctx: ShellContext): Promise<ShellResult>;
export declare function npmWhoami(vol: MemoryVolume, ctx: ShellContext): Promise<ShellResult>;
export declare function npmFund(vol: MemoryVolume, ctx: ShellContext): Promise<ShellResult>;
export declare function npmOutdated(vol: MemoryVolume, ctx: ShellContext): Promise<ShellResult>;
export declare function npmAudit(vol: MemoryVolume, ctx: ShellContext): Promise<ShellResult>;
export declare function npmPack(vol: MemoryVolume, ctx: ShellContext): ShellResult;
export interface LockPackage {
    name: string;
    version: string;
    resolved?: string;
    integrity?: string;
}
export declare function readPackageLock(vol: MemoryVolume, cwd: string): {
    packages: LockPackage[];
    lockfileVersion: number;
} | null;
export declare function packageJsonDepsMatchLock(vol: MemoryVolume, cwd: string, lockPkgs: LockPackage[]): {
    ok: true;
} | {
    ok: false;
    reason: string;
};
export declare function writeNpmPackageLock(vol: MemoryVolume, cwd: string, tree: Map<string, {
    version: string;
    tarballUrl: string;
    dependencies?: Record<string, string>;
}>, rootPkg?: {
    name?: string;
    version?: string;
}): void;
