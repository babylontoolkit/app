export type NodepodSWFrameworkHint = "vite" | "next" | "generic";
export interface NodepodSWSetupErrorDetails {
    swUrl: string;
    status?: number;
    contentType?: string;
    /** Underlying network/abort error, if the preflight never got a response. */
    cause?: unknown;
    framework: NodepodSWFrameworkHint;
}
export declare class NodepodSWSetupError extends Error {
    readonly details: NodepodSWSetupErrorDetails;
    constructor(message: string, details: NodepodSWSetupErrorDetails);
    toString(): string;
}
/**
 * Guess which framework hint to show by sniffing the current runtime.
 * Defaults to "generic" if nothing matches.
 */
export declare function detectFrameworkHint(): NodepodSWFrameworkHint;
