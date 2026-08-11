import type { RuntimeHost } from "../types";
export interface NodeHostOptions {
    /** Absolute path to dist/__worker__.js (or equivalent IIFE bundle). */
    workerPath?: string;
    /** Directory for package snapshot cache. Defaults to NODEPOD_CACHE / os.tmpdir(). */
    cacheDir?: string;
    /** Local HTTP bind host. Default 127.0.0.1 */
    httpHost?: string;
    /** Local HTTP bind port (0 = ephemeral). Default 0 */
    httpPort?: number;
}
export declare function createNodeHost(opts?: NodeHostOptions): RuntimeHost;
