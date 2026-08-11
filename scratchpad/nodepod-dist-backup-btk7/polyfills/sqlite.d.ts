import type { MemoryVolume } from "../memory-volume";
export declare const constants: {
    readonly SQLITE_CHANGESET_DATA: 1;
    readonly SQLITE_CHANGESET_NOTFOUND: 2;
    readonly SQLITE_CHANGESET_CONFLICT: 3;
    readonly SQLITE_CHANGESET_CONSTRAINT: 4;
    readonly SQLITE_CHANGESET_FOREIGN_KEY: 5;
    readonly SQLITE_CHANGESET_OMIT: 0;
    readonly SQLITE_CHANGESET_REPLACE: 1;
    readonly SQLITE_CHANGESET_ABORT: 2;
    readonly SQLITE_OK: 0;
    readonly SQLITE_DENY: 1;
    readonly SQLITE_IGNORE: 2;
    readonly SQLITE_CREATE_INDEX: 1;
    readonly SQLITE_CREATE_TABLE: 2;
    readonly SQLITE_CREATE_TEMP_INDEX: 3;
    readonly SQLITE_CREATE_TEMP_TABLE: 4;
    readonly SQLITE_CREATE_TEMP_TRIGGER: 5;
    readonly SQLITE_CREATE_TEMP_VIEW: 6;
    readonly SQLITE_CREATE_TRIGGER: 7;
    readonly SQLITE_CREATE_VIEW: 8;
    readonly SQLITE_CREATE_VTABLE: 9;
    readonly SQLITE_DELETE: 10;
    readonly SQLITE_DROP_INDEX: 11;
    readonly SQLITE_DROP_TABLE: 12;
    readonly SQLITE_DROP_TEMP_INDEX: 13;
    readonly SQLITE_DROP_TEMP_TABLE: 14;
    readonly SQLITE_DROP_TEMP_TRIGGER: 15;
    readonly SQLITE_DROP_TEMP_VIEW: 16;
    readonly SQLITE_DROP_TRIGGER: 17;
    readonly SQLITE_DROP_VIEW: 18;
    readonly SQLITE_DROP_VTABLE: 19;
    readonly SQLITE_INSERT: 20;
    readonly SQLITE_PRAGMA: 21;
    readonly SQLITE_READ: 22;
    readonly SQLITE_SELECT: 23;
    readonly SQLITE_TRANSACTION: 24;
    readonly SQLITE_UPDATE: 25;
    readonly SQLITE_ATTACH: 26;
    readonly SQLITE_DETACH: 27;
    readonly SQLITE_ALTER_TABLE: 28;
    readonly SQLITE_REINDEX: 29;
    readonly SQLITE_ANALYZE: 30;
};
export declare function setVolume(vol: MemoryVolume): void;
export declare function setSqliteCwd(cwd: string): void;
export declare const WASM_CACHE_PATH = "/.nodepod/wa-sqlite.wasm";
export declare const WASM_SAB_HEADER_BYTES = 16;
export declare const WASM_SAB_MAX_BYTES: number;
export interface SqliteHostBridge {
    ensureWasmCached(): void;
}
export declare function setSqliteHostBridge(bridge: SqliteHostBridge | null): void;
/** @internal test helper */
export declare function __resetSqliteEngineForTesting(): void;
export declare function preloadSqlite(): Promise<boolean>;
export declare function warmSqliteEngine(): Promise<boolean>;
export declare function warmSqliteWasmBytes(): boolean;
interface DbOptions {
    open?: boolean;
    readBigInts?: boolean;
    returnArrays?: boolean;
    allowExtension?: boolean;
    allowBareNamedParameters?: boolean;
    allowUnknownNamedParameters?: boolean;
    defensive?: boolean;
}
export interface StatementSync {
    readonly sourceSQL: string;
    readonly expandedSQL: string;
    run(...params: unknown[]): {
        changes: number | bigint;
        lastInsertRowid: number | bigint;
    };
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    iterate(...params: unknown[]): IterableIterator<unknown>;
    columns(): Array<{
        column: string | null;
        database: string | null;
        name: string;
        table: string | null;
        type: string | null;
    }>;
    setAllowBareNamedParameters(enabled: boolean): void;
    setAllowUnknownNamedParameters(enabled: boolean): void;
    setReturnArrays(enabled: boolean): void;
    setReadBigInts(enabled: boolean): void;
}
declare class StatementSyncImpl implements StatementSync {
    private readonly _db;
    private readonly _handle;
    readonly sourceSQL: string;
    private _expandedSQL;
    private _readBigInts;
    private _returnArrays;
    private _allowBareNamed;
    private _allowUnknownNamed;
    private _closed;
    private readonly _stmt;
    private readonly _str;
    get expandedSQL(): string;
    constructor(_db: DatabaseSync, _handle: number, sql: string, opts: DbOptions);
    private bindParams;
    run(named?: Record<string, unknown> | unknown[], ...rest: unknown[]): {
        changes: number;
        lastInsertRowid: number | bigint;
    };
    get(named?: Record<string, unknown> | unknown[], ...rest: unknown[]): unknown;
    all(named?: Record<string, unknown> | unknown[], ...rest: unknown[]): unknown[];
    iterate(named?: Record<string, unknown> | unknown[], ...rest: unknown[]): Generator<unknown, void, unknown>;
    columns(): {
        column: null;
        database: null;
        name: string;
        table: null;
        type: null;
    }[];
    setAllowBareNamedParameters(v: boolean): void;
    setAllowUnknownNamedParameters(v: boolean): void;
    setReturnArrays(v: boolean): void;
    setReadBigInts(v: boolean): void;
    _close(): void;
}
export declare const StatementSync: {
    new (): StatementSync;
    prototype: StatementSync;
};
export declare class Session {
    private readonly _db;
    constructor(_db: DatabaseSync);
    changeset(): Uint8Array;
    patchset(): Uint8Array;
    close(): void;
    [Symbol.dispose](): void;
}
export declare class SQLTagStore {
    private readonly _db;
    private cache;
    readonly capacity: number;
    get size(): number;
    get db(): DatabaseSync;
    constructor(_db: DatabaseSync, maxSize?: number);
    clear(): void;
    private getStmt;
    private tagSql;
    run(strings: TemplateStringsArray, ...values: unknown[]): {
        changes: number;
        lastInsertRowid: number | bigint;
    };
    get(strings: TemplateStringsArray, ...values: unknown[]): unknown;
    all(strings: TemplateStringsArray, ...values: unknown[]): unknown[];
    iterate(strings: TemplateStringsArray, ...values: unknown[]): Generator<unknown, void, unknown>;
}
interface DatabaseSyncInterface {
    readonly isOpen: boolean;
    readonly isTransaction: boolean;
    readonly location: string | null;
    readonly limits: Record<string, number>;
    close(): void;
    open(): void;
    exec(sql: string): void;
    prepare(sql: string, options?: object): StatementSync;
    function(name: string, optionsOrFn: object | ((...args: unknown[]) => unknown), fn?: (...args: unknown[]) => unknown): void;
    aggregate(name: string, options: {
        start?: unknown;
        step: (acc: unknown, ...args: unknown[]) => unknown;
        result?: (acc: unknown) => unknown;
        inverse?: (acc: unknown, ...args: unknown[]) => unknown;
    }): void;
    setAuthorizer(callback: ((actionCode: number, arg1: string | null, arg2: string | null, dbName: string | null, triggerOrView: string | null) => number) | null): void;
    enableDefensive(active: boolean): void;
    enableLoadExtension(allow: boolean): void;
    loadExtension(_path: string, _entryPoint?: string): void;
    serialize(dbName?: string): Uint8Array;
    deserialize(buffer: Uint8Array, options?: {
        dbName?: string;
    }): void;
    createSession(_options?: object): Session;
    applyChangeset(_changeset: Uint8Array, _options?: object): boolean;
    createTagStore(maxSize?: number): SQLTagStore;
    [Symbol.dispose](): void;
}
export declare class DatabaseSync implements DatabaseSyncInterface {
    private _handle;
    private _open;
    private _allowExtension;
    private _opts;
    private readonly _statements;
    readonly path: string;
    readonly resolvedPath: string;
    constructor(path: string | URL | Buffer, options?: DbOptions);
    get isOpen(): boolean;
    get isTransaction(): boolean;
    get location(): string | null;
    get limits(): Record<string, number>;
    open(): void;
    close(): void;
    _trackStatement(stmt: StatementSyncImpl): void;
    _untrackStatement(stmt: StatementSyncImpl): void;
    [Symbol.dispose](): void;
    exec(sql: string): void;
    prepare(sql: string, options?: DbOptions): StatementSync;
    function(name: string, optionsOrFn: object | ((...args: unknown[]) => unknown), fn?: (...args: unknown[]) => unknown): void;
    aggregate(name: string, options: {
        start?: unknown;
        step: (acc: unknown, ...args: unknown[]) => unknown;
        result?: (acc: unknown) => unknown;
        inverse?: (acc: unknown, ...args: unknown[]) => unknown;
    }): void;
    setAuthorizer(callback: ((actionCode: number, arg1: string | null, arg2: string | null, dbName: string | null, triggerOrView: string | null) => number) | null): void;
    enableDefensive(_active: boolean): void;
    enableLoadExtension(allow: boolean): void;
    loadExtension(_path: string, _entryPoint?: string): void;
    serialize(_dbName?: string): Uint8Array;
    deserialize(buffer: Uint8Array, _options?: {
        dbName?: string;
    }): void;
    createSession(_options?: object): Session;
    applyChangeset(_changeset: Uint8Array, _options?: object): boolean;
    createTagStore(maxSize?: number): SQLTagStore;
    private assertOpen;
}
export declare function backup(sourceDb: DatabaseSync, path: string | URL | Buffer, options?: {
    source?: string;
    target?: string;
    rate?: number;
    progress?: (info: {
        totalPages: number;
        remainingPages: number;
    }) => void;
}): Promise<number>;
declare const _default: {
    DatabaseSync: typeof DatabaseSync;
    StatementSync: {
        new (): StatementSync;
        prototype: StatementSync;
    };
    Session: typeof Session;
    SQLTagStore: typeof SQLTagStore;
    backup: typeof backup;
    constants: {
        readonly SQLITE_CHANGESET_DATA: 1;
        readonly SQLITE_CHANGESET_NOTFOUND: 2;
        readonly SQLITE_CHANGESET_CONFLICT: 3;
        readonly SQLITE_CHANGESET_CONSTRAINT: 4;
        readonly SQLITE_CHANGESET_FOREIGN_KEY: 5;
        readonly SQLITE_CHANGESET_OMIT: 0;
        readonly SQLITE_CHANGESET_REPLACE: 1;
        readonly SQLITE_CHANGESET_ABORT: 2;
        readonly SQLITE_OK: 0;
        readonly SQLITE_DENY: 1;
        readonly SQLITE_IGNORE: 2;
        readonly SQLITE_CREATE_INDEX: 1;
        readonly SQLITE_CREATE_TABLE: 2;
        readonly SQLITE_CREATE_TEMP_INDEX: 3;
        readonly SQLITE_CREATE_TEMP_TABLE: 4;
        readonly SQLITE_CREATE_TEMP_TRIGGER: 5;
        readonly SQLITE_CREATE_TEMP_VIEW: 6;
        readonly SQLITE_CREATE_TRIGGER: 7;
        readonly SQLITE_CREATE_VIEW: 8;
        readonly SQLITE_CREATE_VTABLE: 9;
        readonly SQLITE_DELETE: 10;
        readonly SQLITE_DROP_INDEX: 11;
        readonly SQLITE_DROP_TABLE: 12;
        readonly SQLITE_DROP_TEMP_INDEX: 13;
        readonly SQLITE_DROP_TEMP_TABLE: 14;
        readonly SQLITE_DROP_TEMP_TRIGGER: 15;
        readonly SQLITE_DROP_TEMP_VIEW: 16;
        readonly SQLITE_DROP_TRIGGER: 17;
        readonly SQLITE_DROP_VIEW: 18;
        readonly SQLITE_DROP_VTABLE: 19;
        readonly SQLITE_INSERT: 20;
        readonly SQLITE_PRAGMA: 21;
        readonly SQLITE_READ: 22;
        readonly SQLITE_SELECT: 23;
        readonly SQLITE_TRANSACTION: 24;
        readonly SQLITE_UPDATE: 25;
        readonly SQLITE_ATTACH: 26;
        readonly SQLITE_DETACH: 27;
        readonly SQLITE_ALTER_TABLE: 28;
        readonly SQLITE_REINDEX: 29;
        readonly SQLITE_ANALYZE: 30;
    };
    preloadSqlite: typeof preloadSqlite;
    warmSqliteWasmBytes: typeof warmSqliteWasmBytes;
    setVolume: typeof setVolume;
    setSqliteCwd: typeof setSqliteCwd;
    setSqliteHostBridge: typeof setSqliteHostBridge;
    WASM_CACHE_PATH: string;
};
export default _default;
