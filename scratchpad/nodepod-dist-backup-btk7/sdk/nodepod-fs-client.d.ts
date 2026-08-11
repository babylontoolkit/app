import { SharedVFSReader } from "../threading/shared-vfs";
import type { SharedVFSStat } from "../threading/shared-vfs";
export declare class NodepodFSClientError extends Error {
    readonly code: string;
    constructor(code: string, message: string);
}
export declare class NodepodFSClient {
    private _reader;
    constructor(_reader: SharedVFSReader);
    readFile(path: string, encoding: "utf-8" | "utf8"): Promise<string>;
    readFile(path: string): Promise<Uint8Array>;
    exists(path: string): Promise<boolean>;
    stat(path: string): Promise<SharedVFSStat>;
    readdir(path: string): Promise<string[]>;
    /** SAB version counter, bumped on every write/delete. */
    get version(): number;
    /**
     * Block until the version changes or timeout. returns the new version, or
     * -1 on timeout. don't call this on a browser main thread, Atomics.wait
     * throws there.
     */
    waitForChange(currentVersion: number, timeoutMs?: number): number;
    writeFile(_path: string, _data: string | Uint8Array): Promise<void>;
    mkdir(_path: string, _opts?: {
        recursive?: boolean;
    }): Promise<void>;
    unlink(_path: string): Promise<void>;
    rmdir(_path: string, _opts?: {
        recursive?: boolean;
    }): Promise<void>;
    rename(_from: string, _to: string): Promise<void>;
    appendFile(_path: string, _data: string | Uint8Array): Promise<void>;
    /** escape hatch if you need the sync reader directly */
    get reader(): SharedVFSReader;
}
