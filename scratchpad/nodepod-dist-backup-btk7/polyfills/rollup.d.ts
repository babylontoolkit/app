export declare function setVFSBridge(mkdirSync: (path: string, opts?: {
    recursive?: boolean;
}) => void, writeFileSync: (path: string, data: string | Uint8Array) => void): void;
declare function ensureRollup(): Promise<unknown>;
export declare const VERSION: string;
export declare function rollup(inputOptions: unknown): Promise<unknown>;
export declare function watch(watchOptions: unknown): Promise<unknown>;
export declare function defineConfig<T>(config: T): T;
type ParseAstOpts = {
    allowReturnOutsideFunction?: boolean;
    jsx?: boolean;
    lang?: string;
    preserveParens?: boolean;
    signal?: AbortSignal;
} | null;
export declare function parseAst(source: string, opts?: ParseAstOpts, filename?: string): unknown;
export declare function parseAstAsync(source: string, opts?: ParseAstOpts, filename?: string): Promise<unknown>;
export declare function getPackageBase(): string;
export { ensureRollup as loadRollup };
export interface Plugin {
    name: string;
    [key: string]: unknown;
}
export interface PluginContext {
    meta: {
        rollupVersion: string;
    };
    parse: (code: string) => unknown;
    [key: string]: unknown;
}
declare const _default: {
    VERSION: string;
    rollup: typeof rollup;
    watch: typeof watch;
    defineConfig: typeof defineConfig;
    parseAst: typeof parseAst;
    parseAstAsync: typeof parseAstAsync;
    loadRollup: typeof ensureRollup;
};
export default _default;
