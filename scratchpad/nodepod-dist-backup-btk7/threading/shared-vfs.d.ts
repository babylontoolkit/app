export declare function isSharedArrayBufferAvailable(): boolean;
export interface SharedVFSStats {
    entries: number;
    activeEntries: number;
    dataUsed: number;
    wasteBytes: number;
    droppedWrites: number;
    bufferSize: number;
    compactions: number;
}
export interface SharedVFSStat {
    isFile: boolean;
    isDirectory: boolean;
    size: number;
    /** ms since epoch. resolution is seconds, the SAB only stores seconds. */
    mtime: number;
}
export declare class SharedVFSController {
    private _buffer;
    private _view;
    private _int32;
    private _uint8;
    private _pathEncoder;
    private _pathDecoder;
    private _droppedWrites;
    private _compactions;
    constructor(bufferSize?: number);
    get buffer(): SharedArrayBuffer;
    writeFile(path: string, content: Uint8Array): boolean;
    private _pathTooLong;
    private _writeFileLocked;
    writeDirectory(path: string): boolean;
    deleteFile(path: string): boolean;
    readFile(path: string): Uint8Array | null;
    exists(path: string): boolean;
    get version(): number;
    getStats(): SharedVFSStats;
    compact(): void;
    private _addWaste;
    private _inactiveCount;
    private _shouldCompact;
    private _writePath;
    private _compactLocked;
    private _findEntry;
    private _updateEntry;
    private _lock;
    private _unlock;
}
export declare class SharedVFSReader {
    private _buffer;
    private _view;
    private _int32;
    private _uint8;
    private _pathEncoder;
    private _pathDecoder;
    constructor(buffer: SharedArrayBuffer);
    readFileSync(path: string): Uint8Array | null;
    existsSync(path: string): boolean;
    isDirectorySync(path: string): boolean;
    statSync(path: string): SharedVFSStat | null;
    readdirSync(dir: string): string[];
    get version(): number;
    waitForChange(currentVersion: number, timeoutMs?: number): number;
    private _findEntry;
    private _readPath;
}
