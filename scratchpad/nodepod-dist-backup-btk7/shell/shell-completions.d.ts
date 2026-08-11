import type { MemoryVolume } from "../memory-volume";
export interface CompletionResult {
    token: string;
    tokenStart: number;
    /** dirs end with '/', files with ' ' */
    matches: string[];
}
export interface CompletionOptions {
    /** extra command names for first-word completion (registered commands, PATH execs) */
    extraCommands?: Iterable<string>;
}
export declare function getCompletions(line: string, cursorPos: number, cwd: string, volume: MemoryVolume, builtinNames: Iterable<string>, opts?: CompletionOptions): CompletionResult;
export declare function longestCommonPrefix(strs: string[]): string;
