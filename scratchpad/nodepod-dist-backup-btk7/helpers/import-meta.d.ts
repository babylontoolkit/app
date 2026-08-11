export interface NodeImportMeta {
    url: string;
    filename: string;
    dirname: string;
    /** true when this module is the process entry point (Node >= 24.2 / 22.18). */
    main: boolean;
    /** Resolve a specifier to a URL string relative to this module (or parent). */
    resolve: (specifier: string, parent?: string | URL) => string;
}
export interface CreateImportMetaOptions {
    filename: string;
    dirname: string;
    /** Resolve a specifier to an absolute filesystem path (or bare builtin id). */
    resolvePath: (specifier: string, fromDir: string) => string;
    isMain: boolean;
    /** Return true when `id` is a node builtin (with or without node: prefix). */
    isBuiltin?: (id: string) => boolean;
}
/**
 * Build the import.meta object injected as $importMeta into every module wrapper.
 */
export declare function createImportMeta(opts: CreateImportMetaOptions): NodeImportMeta;
