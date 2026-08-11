export interface TarEntry {
    path: string;
    content: Uint8Array | string;
    mode?: number;
    mtime?: number;
}
export declare function packTar(entries: TarEntry[]): Uint8Array;
export declare function packTarGz(entries: TarEntry[]): Uint8Array;
