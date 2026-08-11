import type { VolumeSnapshot } from './engine-types';
import type { MemoryHandler } from './memory-handler';
export interface VolumeNode {
    kind: 'file' | 'directory' | 'symlink';
    content?: Uint8Array;
    children?: Map<string, VolumeNode>;
    target?: string;
    modified: number;
    /** Directory/symlink permission bits (files use inode.mode). Default 0o755 / 0o777. */
    mode?: number;
    /** Symlink atime (mtime uses `modified`). */
    atime?: number;
    uid?: number;
    gid?: number;
    /** Windows-style symlink type hint: 'file' | 'dir' | 'junction'. */
    symlinkType?: string;
    lazy?: boolean;
    lazySize?: number;
    inode?: VolumeFileInode;
}
interface VolumeFileInode {
    ino: number;
    content?: Uint8Array;
    mode: number;
    atime: number;
    mtime: number;
    ctime: number;
    nlink: number;
    uid?: number;
    gid?: number;
}
export interface VolumeFileHandle {
    read(): Uint8Array;
    write(data: Uint8Array): void;
    stat(): {
        size: number;
        mode: number;
        atimeMs: number;
        mtimeMs: number;
        ctimeMs: number;
        ino: number;
        nlink: number;
    };
}
export interface BinaryVolumeEntry {
    path: string;
    offset: number;
    length: number;
    isDirectory: boolean;
    symlinkTarget?: string;
    inode?: number;
    mode?: number;
    atimeMs?: number;
    mtimeMs?: number;
    ctimeMs?: number;
    nlink?: number;
    uid?: number;
    gid?: number;
}
export interface VolumeMissHandler {
    readFile(path: string): Uint8Array | null;
    readdir(path: string): Array<{
        name: string;
        isDirectory: boolean;
        size?: number;
    }> | null;
    stat(path: string): {
        isFile: boolean;
        isDirectory: boolean;
        size: number;
    } | null;
    statMany?(paths: string[]): Array<{
        isFile: boolean;
        isDirectory: boolean;
        size: number;
    } | null> | null;
}
type FileChangeHandler = (filePath: string, content: string) => void;
type FileDeleteHandler = (filePath: string) => void;
export interface FileStat {
    isFile(): boolean;
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
    isBlockDevice(): boolean;
    isCharacterDevice(): boolean;
    isFIFO(): boolean;
    isSocket(): boolean;
    size: number;
    mode: number;
    mtime: Date;
    atime: Date;
    ctime: Date;
    birthtime: Date;
    mtimeMs: number;
    atimeMs: number;
    ctimeMs: number;
    birthtimeMs: number;
    nlink: number;
    uid: number;
    gid: number;
    dev: number;
    ino: number;
    rdev: number;
    blksize: number;
    blocks: number;
    atimeNs: bigint;
    mtimeNs: bigint;
    ctimeNs: bigint;
    birthtimeNs: bigint;
}
export type WatchEventKind = 'change' | 'rename';
export type WatchCallback = (event: WatchEventKind, name: string | null) => void;
export interface FileWatchHandle {
    close(): void;
    ref(): this;
    unref(): this;
    on(event: string, listener: (...args: unknown[]) => void): this;
    once(event: string, listener: (...args: unknown[]) => void): this;
    removeListener(event: string, listener: (...args: unknown[]) => void): this;
    off(event: string, listener: (...args: unknown[]) => void): this;
    addListener(event: string, listener: (...args: unknown[]) => void): this;
    removeAllListeners(event?: string): this;
    emit(event: string, ...args: unknown[]): boolean;
}
export interface SystemError extends Error {
    code: string;
    errno: number;
    syscall: string;
    path?: string;
}
export declare function makeSystemError(code: 'ENOENT' | 'ENOTDIR' | 'EISDIR' | 'EEXIST' | 'ENOTEMPTY' | 'ELOOP' | 'EACCES', syscall: string, targetPath: string, detail?: string): SystemError;
export declare class MemoryVolume {
    private tree;
    private _disposed;
    private textEncoder;
    private textDecoder;
    private _missHandler;
    private _lazyDirNames;
    private _lazyListed;
    private _lazyNegative;
    private _lazyInvalidated;
    private _lazyResident;
    private _lazyResidentBytes;
    private _lazyResidentMaxBytes;
    private _inos;
    private _nextIno;
    private _fileInode;
    private _fileContent;
    private _pathsForInode;
    private _releaseNodeLinks;
    private _inoFor;
    private decodeText;
    private toBytes;
    private activeWatchers;
    private subscribers;
    private _handler;
    private _bulkMountHandler;
    constructor(handler?: MemoryHandler | null, lazyResidentMaxBytes?: number);
    on(event: 'change', handler: FileChangeHandler): this;
    on(event: 'delete', handler: FileDeleteHandler): this;
    off(event: 'change', handler: FileChangeHandler): this;
    off(event: 'delete', handler: FileDeleteHandler): this;
    setBulkMountHandler(handler: typeof this._bulkMountHandler): void;
    private broadcast;
    getStats(): {
        fileCount: number;
        totalBytes: number;
        dirCount: number;
        watcherCount: number;
        lazyResidentBytes: number;
    };
    /** Clean up all owned data and listeners. A disposed volume is empty. */
    dispose(): void;
    toSnapshot(excludePrefixes?: string[], excludeDirNames?: Set<string>): VolumeSnapshot;
    private collectEntries;
    static fromBinarySnapshot(snapshot: {
        manifest: BinaryVolumeEntry[];
        data: ArrayBuffer;
    }): MemoryVolume;
    mountBinarySnapshot(snapshot: {
        manifest: BinaryVolumeEntry[];
        data: ArrayBuffer;
    }, notifyBulk?: boolean): number;
    private _mountBinaryEntries;
    static fromSnapshot(snapshot: VolumeSnapshot): MemoryVolume;
    private normalize;
    private segments;
    private parentOf;
    private nameOf;
    private resolveNode;
    private locateRaw;
    private locate;
    private ensureDir;
    private ensureDirTracked;
    private writeInternal;
    setMissHandler(handler: VolumeMissHandler | null, lazyDirNames?: string[]): void;
    private _untrackLazyResident;
    private _untrackLazyTree;
    private _remapLazyTree;
    private _invalidateLazyListedFor;
    /** Mark every directory entry that shares this inode as a lazy stub. */
    private _evictInodeContent;
    private _trackLazyResident;
    private _touchLazyResident;
    markLazyInvalidated(p: string): void;
    private _isUnderLazy;
    private _hydrateMiss;
    private _hydrateStub;
    private _hydrateStubStat;
    private _hydrateTree;
    private _lazyList;
    existsSync(p: string): boolean;
    statSync(p: string): FileStat;
    lstatSync(p: string): FileStat;
    readFileSync(p: string): Uint8Array;
    readFileSync(p: string, encoding: 'utf8' | 'utf-8'): string;
    openFileHandleSync(p: string): VolumeFileHandle;
    writeFileSync(p: string, data: string | Uint8Array | ArrayBuffer | ArrayBufferView | unknown): void;
    writeCacheSync(p: string, data: string | Uint8Array | ArrayBuffer | ArrayBufferView | unknown): void;
    mkdirSync(p: string, options?: {
        recursive?: boolean;
        mode?: number;
    }): string | undefined;
    readdirSync(p: string): string[];
    unlinkSync(p: string): void;
    rmdirSync(p: string): void;
    removeTreeSync(p: string): void;
    renameSync(from: string, to: string): void;
    accessSync(p: string, mode?: number): void;
    copyFileSync(src: string, dest: string, mode?: number): void;
    realpathSync(p: string): string;
    symlinkSync(target: string, linkPath: string, type?: string): void;
    readlinkSync(p: string): string;
    linkSync(existingPath: string, newPath: string): void;
    chmodSync(_p: string, _mode: number): void;
    lchmodSync(p: string, mode: number): void;
    chownSync(p: string, uid: number, gid: number): void;
    lchownSync(p: string, uid: number, gid: number): void;
    private _parseTimes;
    utimesSync(p: string, atime: number | Date, mtime: number | Date): void;
    lutimesSync(p: string, atime: number | Date, mtime: number | Date): void;
    appendFileSync(p: string, data: string | Uint8Array | unknown): void;
    truncateSync(p: string, len?: number): void;
    readFile(p: string, optionsOrCb?: {
        encoding?: string;
    } | ((err: Error | null, data?: Uint8Array | string) => void), cb?: (err: Error | null, data?: Uint8Array | string) => void): void;
    stat(p: string, cb?: (err: Error | null, stats?: FileStat) => void): void;
    lstat(p: string, cb?: (err: Error | null, stats?: FileStat) => void): void;
    readdir(p: string, optionsOrCb?: {
        withFileTypes?: boolean;
    } | ((err: Error | null, files?: string[]) => void), cb?: (err: Error | null, files?: string[]) => void): void;
    realpath(p: string, cb?: (err: Error | null, resolved?: string) => void): void;
    access(p: string, modeOrCb?: number | ((err: Error | null) => void), cb?: (err: Error | null) => void): void;
    watch(target: string, optionsOrCb?: {
        persistent?: boolean;
        recursive?: boolean;
        encoding?: string;
    } | WatchCallback, cb?: WatchCallback): FileWatchHandle;
    private triggerWatchers;
    private globalChangeListeners;
    onGlobalChange(cb: (path: string, event: string) => void): () => void;
    private notifyGlobalListeners;
    createReadStream(p: string): {
        on: (event: string, cb: (...args: unknown[]) => void) => void;
        pipe: (dest: unknown) => unknown;
    };
    createWriteStream(p: string): {
        write: (data: string | Uint8Array) => boolean;
        end: (data?: string | Uint8Array) => void;
        on: (event: string, cb: (...args: unknown[]) => void) => void;
    };
}
export {};
