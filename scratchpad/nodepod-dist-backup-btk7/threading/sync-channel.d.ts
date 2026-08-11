export declare const SLOT_SIZE = 4096;
export declare const MAX_SLOTS = 64;
/** Pack slot index + generation into the opaque syncSlot handle posted to main. */
export declare function encodeSyncSlot(slot: number, generation: number): number;
/** Unpack opaque syncSlot handle into SAB index + generation. */
export declare function decodeSyncSlot(handle: number): {
    slot: number;
    generation: number;
};
export declare class SyncChannelController {
    private _buffer;
    private _int32;
    private _uint8;
    constructor(bufferSize?: number);
    get buffer(): SharedArrayBuffer;
    writeResult(syncSlot: number, exitCode: number, stdout: string): void;
    writeError(syncSlot: number, exitCode: number, errorMessage: string): void;
}
export declare class SyncChannelWorker {
    private _int32;
    private _uint8;
    constructor(buffer: SharedArrayBuffer);
    /** Allocate a free slot; returns opaque handle (slot + generation). Never reuses in-flight slots. */
    allocateSlot(): number;
    waitForResult(syncSlot: number, timeoutMs?: number): {
        exitCode: number;
        stdout: string;
    };
}
