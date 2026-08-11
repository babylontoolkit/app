type EntryKind = "file" | "directory" | "link" | "other";
interface TarEntry {
    filepath: string;
    kind: EntryKind;
    byteSize: number;
    payload?: Uint8Array;
}
export declare class ByteQueue {
    private chunks;
    private offset;
    available: number;
    push(chunk: Uint8Array): void;
    take(length: number): Uint8Array;
    skip(length: number): void;
}
export declare function parseTarStream(stream: ReadableStream<Uint8Array>): AsyncGenerator<TarEntry>;
export {};
