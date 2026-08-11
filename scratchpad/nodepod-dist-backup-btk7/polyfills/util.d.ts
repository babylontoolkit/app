/**
 * Options accepted by `inspect` — and therefore by `formatWithOptions`, which threads them through.
 *
 * Deliberately the full Node shape rather than the two keys this implementation reads. The narrow
 * `{ depth?, colors? }` it replaced made `formatWithOptions` a lie at the type level: callers pass
 * whatever Node accepts (`debug` passes its whole `inspectOpts` bag), so a signature that rejects
 * them would either fail to compile or force a cast at every call site.
 *
 * ⚠️ Only `depth` is honoured today; the rest are accepted and ignored. That is a real gap, but a
 * documented one — the alternative was to keep a type that could not express what callers send.
 */
export interface InspectOptions {
    depth?: number | null;
    colors?: boolean;
    showHidden?: boolean;
    showProxy?: boolean;
    maxArrayLength?: number | null;
    maxStringLength?: number | null;
    breakLength?: number;
    compact?: boolean | number;
    sorted?: boolean | ((a: string, b: string) => number);
    getters?: boolean | "get" | "set";
    numericSeparator?: boolean;
    customInspect?: boolean;
}
export declare function format(template: unknown, ...values: unknown[]): string;
/**
 * `util.formatWithOptions(inspectOptions, format[, ...args])` — Node 10+.
 *
 * 🔴 This is the symbol whose absence broke EVERY published game. `debug` — a transitive dependency of
 * essentially every build tool — logs through `util.formatWithOptions(exports.inspectOpts, ...args)`,
 * so `vite build` died with `TypeError: formatWithOptions is not a function` before emitting anything.
 * Dev never reached that logger, which is why only publishing was broken.
 *
 * ⚠️ Node throws `ERR_INVALID_ARG_TYPE` when `inspectOptions` is not an object. This is deliberately
 * lenient instead: a bad options bag degrades to `{}` rather than throwing, because the failure mode
 * of throwing here is exactly the one being fixed — a build that dies inside a logger.
 */
export declare function formatWithOptions(inspectOptions: InspectOptions, template?: unknown, ...values: unknown[]): string;
export declare function inspect(target: unknown, opts?: InspectOptions): string;
export declare function inherits(child: Function, parent: Function): void;
export declare function _extend(target: any, source: any): any;
export declare function deprecate<T extends Function>(fn: T, message: string, code?: string): T;
export declare function promisify<T>(fn: (...args: any[]) => void): (...args: any[]) => Promise<T>;
export declare function callbackify<T>(fn: (...args: any[]) => Promise<T>): (...args: any[]) => void;
export declare function isDeepStrictEqual(a: unknown, b: unknown): boolean;
export declare function isArray(val: unknown): val is unknown[];
export declare function isBoolean(val: unknown): val is boolean;
export declare function isNull(val: unknown): val is null;
export declare function isNullOrUndefined(val: unknown): val is null | undefined;
export declare function isNumber(val: unknown): val is number;
export declare function isString(val: unknown): val is string;
export declare function isUndefined(val: unknown): val is undefined;
export declare function isRegExp(val: unknown): val is RegExp;
export declare function isObject(val: unknown): val is object;
export declare function isDate(val: unknown): val is Date;
export declare function isError(val: unknown): val is Error;
export declare function isFunction(val: unknown): val is Function;
export declare function isPrimitive(val: unknown): boolean;
export declare function isBuffer(val: unknown): boolean;
export declare function isPromise(val: unknown): val is Promise<unknown>;
export declare function debuglog(section: string): (...args: unknown[]) => void;
export declare const debug: typeof debuglog;
export declare function stripVTControlCharacters(text: string): string;
declare function isTypedArray(val: unknown): val is ArrayBufferView;
declare function isUint8Array(val: unknown): val is Uint8Array;
declare function isArrayBuffer(val: unknown): val is ArrayBuffer;
declare function isDataView(val: unknown): val is DataView;
declare function isAnyArrayBuffer(val: unknown): boolean;
declare function isMap(val: unknown): val is Map<unknown, unknown>;
declare function isSet(val: unknown): val is Set<unknown>;
declare function isBooleanObject(val: unknown): boolean;
declare function isNumberObject(val: unknown): boolean;
declare function isStringObject(val: unknown): boolean;
declare function isSymbolObject(val: unknown): boolean;
declare function isBoxedPrimitive(val: unknown): boolean;
declare function isAsyncFunction(val: unknown): boolean;
declare function isGeneratorFunction(val: unknown): boolean;
declare function isGeneratorObject(val: unknown): boolean;
declare function isNativeError(val: unknown): val is Error;
declare function isProxy(val: unknown): boolean;
export declare const types: {
    isDate: typeof isDate;
    isRegExp: typeof isRegExp;
    isNativeError: typeof isNativeError;
    isError: typeof isNativeError;
    isMap: typeof isMap;
    isSet: typeof isSet;
    isPromise: typeof isPromise;
    isTypedArray: typeof isTypedArray;
    isUint8Array: typeof isUint8Array;
    isArrayBuffer: typeof isArrayBuffer;
    isDataView: typeof isDataView;
    isAnyArrayBuffer: typeof isAnyArrayBuffer;
    isBoxedPrimitive: typeof isBoxedPrimitive;
    isBooleanObject: typeof isBooleanObject;
    isNumberObject: typeof isNumberObject;
    isStringObject: typeof isStringObject;
    isSymbolObject: typeof isSymbolObject;
    isAsyncFunction: typeof isAsyncFunction;
    isGeneratorFunction: typeof isGeneratorFunction;
    isGeneratorObject: typeof isGeneratorObject;
    isProxy: typeof isProxy;
    isBuffer: typeof isBuffer;
};
export declare function styleText(format: string | string[], text: string): string;
interface ParseArgsOptionConfig {
    type: "string" | "boolean";
    short?: string;
    multiple?: boolean;
    default?: string | boolean | string[] | boolean[];
}
interface ParseArgsConfig {
    args?: string[];
    options?: Record<string, ParseArgsOptionConfig>;
    strict?: boolean;
    allowPositionals?: boolean;
    tokens?: boolean;
}
interface ParseArgsResult {
    values: Record<string, string | boolean | (string | boolean)[] | undefined>;
    positionals: string[];
    tokens?: Array<{
        kind: string;
        name?: string;
        value?: string | boolean;
        index: number;
    }>;
}
export declare function parseArgs(config?: ParseArgsConfig): ParseArgsResult;
/**
 * Replaces lone surrogates with U+FFFD, yielding a well-formed Unicode string.
 *
 * Written as an explicit code-unit walk rather than a regex with lookbehind: lookbehind is a
 * relatively recent regex feature and this file is bundled and shipped to whatever browser the pod
 * runs in. A parser that throws at parse time takes the whole module with it.
 */
export declare function toUSVString(value: unknown): string;
/**
 * The parameter bag behind `MIMEType#params`. Node exposes it as a Map-alike, not a Map.
 *
 * ⚠️ CASE-SENSITIVE, and that is not an oversight. Lowercasing here looked like a tidy place to
 * normalise and had three silent consequences: `set('Charset', x)` then `get('charset')` INVENTED a
 * hit where Node returns `null`; `delete('CHARSET')` silently removed a parameter Node would keep;
 * and `toString()` renamed the caller's parameter. The lowercasing belongs in the MIMEType PARSER,
 * which is the only place a wire format defines it — not in the container.
 */
export declare class MIMEParams {
    #private;
    delete(name: string): void;
    get(name: string): string | null;
    has(name: string): boolean;
    set(name: string, value: string): void;
    entries(): IterableIterator<[string, string]>;
    keys(): IterableIterator<string>;
    values(): IterableIterator<string>;
    [Symbol.iterator](): IterableIterator<[string, string]>;
    toString(): string;
}
/**
 * `util.MIMEType` — a parsed `type/subtype;params` value.
 *
 * Matches Node's normalisation: type, subtype and parameter NAMES are lowercased while parameter
 * VALUES keep their case (`TEXT/HTML; Foo=Bar` → `text/html;foo=Bar`).
 */
export declare class MIMEType {
    #private;
    constructor(input: string);
    get type(): string;
    set type(value: string);
    get subtype(): string;
    set subtype(value: string);
    get essence(): string;
    get params(): MIMEParams;
    toString(): string;
    toJSON(): string;
}
/**
 * `util.aborted(signal, resource)` — a promise that settles when `signal` aborts. Never rejects.
 *
 * ⚠️ Node holds a WEAK reference to `resource` so an un-aborted signal cannot leak the resource.
 * `WeakRef` exists in browsers, but the listener itself is what retains memory here, so the
 * parameter is accepted and unused — documented rather than silently dropped.
 */
export declare function aborted(signal: AbortSignal, resource?: unknown): Promise<void>;
/**
 * ⚠️ DEGRADED, deliberately. In Node these mark an AbortSignal as transferable across a
 * `postMessage` boundary. The browser has no such capability — an `AbortSignal` is not structured-
 * cloneable — so these return a perfectly ordinary controller/signal that simply is not transferable.
 *
 * Aborting still works; only cross-worker transfer does not. Returning a WORKING object is the honest
 * choice over throwing: a build tool that calls this to obtain a controller gets one.
 */
export declare function transferableAbortController(): AbortController;
/** ⚠️ DEGRADED — see `transferableAbortController`. Returns the signal unchanged. */
export declare function transferableAbortSignal(signal: AbortSignal): AbortSignal;
export declare function getSystemErrorMap(): Map<number, [string, string]>;
export declare function getSystemErrorName(err: number): string;
export declare function getSystemErrorMessage(err: number): string;
/**
 * Parses `.env`-style content into a plain object — `util.parseEnv(content)`.
 *
 * 🔴 A scanner over the WHOLE text, not a loop over lines. The line-oriented version this replaced
 * looked correct and silently truncated every **multiline quoted value** — `A="line1\nline2"` came
 * back as `'"line1'`, keeping the stray opening quote — which is exactly the shape a PEM private key,
 * a certificate or an embedded JSON blob takes in a real `.env`. It did not throw and did not warn:
 * a plausible wrong answer, which is the one outcome this polyfill is not allowed to produce.
 *
 * Matches Node: `export ` prefixes stripped; `"`, `'` and backtick quoting, each running to its own
 * closing quote and spanning newlines freely; `\n` (and ONLY `\n`, and only in DOUBLE quotes) is
 * expanded, while the quote itself is never escapable — Node reads to the next matching quote, so
 * `A="say \"hi\""` yields `say \`; `#` starts a comment only at the START of a line, though on an
 * unquoted value it also ends the value mid-line; an empty assignment yields `""` rather than being
 * dropped.
 */
export declare function parseEnv(content: string): Record<string, string>;
export type DiffEntry = [-1 | 0 | 1, string];
/**
 * `util.diff(actual, expected)` — an LCS diff.
 *
 * Operation codes follow Node's observed output: **`1` = present in `actual` only**, **`-1` = present
 * in `expected` only**, `0` = common.
 *
 * ⚠️ There are TWO different empty-result rules and they are easy to conflate. Node returns `[]` when
 * the arguments are the SAME REFERENCE (`diff(a, a)`), and separately when two distinct STRINGS are
 * equal. Two distinct but equal ARRAYS give a full run of zeros. An earlier blanket "identical returns
 * `[]`" was pinned in a test as though verified, when only the string case ever had been.
 *
 * ⚠️ TOKENISATION matches Node; the ALIGNMENT does not always. Both produce a valid minimal LCS diff
 * that reconstructs each input exactly, but they break ties differently on roughly 9% of strings, so
 * do not pin `diff` output byte-for-byte against Node for inputs with more than one minimal answer.
 *
 * Strings are compared per **code unit** and arrays per element, as Node does — Node does
 * split a surrogate pair across two entries. ⚠️ `split("")`, NOT `[...str]`: the spread iterates code
 * POINTS, so it kept `"😀"` whole and quietly disagreed with Node on any string containing an emoji,
 * while the comment right here claimed otherwise. A false claim in a comment is how that survives.
 *
 * ⚠️ One deliberate deviation: `diff([], [])` returns `[]` where Node THROWS `TypeError: Cannot
 * convert undefined or null to object` — an internal crash rather than a contract. Two empty inputs
 * genuinely have no differences; reproducing a bug is not parity.
 */
export declare function diff(actual: string | readonly string[], expected: string | readonly string[]): DiffEntry[];
/**
 * ⚠️ DEGRADED, deliberately — an explicit, documented no-op.
 *
 * In Node this toggles printing a JS stack trace when SIGINT arrives. A browser has no SIGINT and no
 * process to signal, so there is nothing to trace. Doing nothing is the whole correct behaviour here;
 * the alternative — throwing — would break any tool that merely calls it during setup.
 */
export declare function setTraceSigInt(enable?: boolean): void;
export interface CallSite {
    functionName: string;
    scriptName: string;
    scriptId: string;
    lineNumber: number;
    columnNumber: number;
    column: number;
}
/**
 * ⚠️ BEST-EFFORT. Node reads real V8 frame data; this reconstructs what it can from
 * `Error.prepareStackTrace`, which V8 supports in Chrome but which other engines do not implement.
 *
 * On an engine without it the structured hook yields a string instead of frames and this returns `[]`
 * — an empty list rather than fabricated frames, because a plausible wrong stack is worse than no
 * stack. `scriptId` is always `"0"`: it is a V8 debugger id with no browser equivalent.
 */
export declare function getCallSites(frames?: number | {
    sourceMap?: boolean;
}, options?: {
    sourceMap?: boolean;
}): CallSite[];
export declare const TextEncoder: {
    new (): TextEncoder;
    prototype: TextEncoder;
};
export declare const TextDecoder: {
    new (label?: string, options?: TextDecoderOptions): TextDecoder;
    prototype: TextDecoder;
};
/**
 * 🔴 EVERY exported symbol must appear BOTH as a named `export` above AND as an entry here.
 *
 * CJS `require('node:util')` receives THIS object, and `debug` — the dependency that broke every
 * published game — calls `util.formatWithOptions(...)` off it. So a named export alone leaves the
 * reported bug exactly as it was for CJS consumers **while looking fixed in the diff**. Vite reaches
 * `node:util` from both module systems, so both paths are live and both must carry every symbol.
 *
 * This list is hand-maintained, which is the whole hazard — `util.test.ts`'s "both surfaces" test exists
 * to fail loudly when a symbol is added above and forgotten here.
 */
declare const _default: {
    format: typeof format;
    formatWithOptions: typeof formatWithOptions;
    inspect: typeof inspect;
    inherits: typeof inherits;
    _extend: typeof _extend;
    deprecate: typeof deprecate;
    promisify: typeof promisify;
    callbackify: typeof callbackify;
    isDeepStrictEqual: typeof isDeepStrictEqual;
    debuglog: typeof debuglog;
    debug: typeof debuglog;
    stripVTControlCharacters: typeof stripVTControlCharacters;
    isArray: typeof isArray;
    isBoolean: typeof isBoolean;
    isNull: typeof isNull;
    isNullOrUndefined: typeof isNullOrUndefined;
    isNumber: typeof isNumber;
    isString: typeof isString;
    isUndefined: typeof isUndefined;
    isRegExp: typeof isRegExp;
    isObject: typeof isObject;
    isDate: typeof isDate;
    isError: typeof isError;
    isFunction: typeof isFunction;
    isPrimitive: typeof isPrimitive;
    isBuffer: typeof isBuffer;
    isPromise: typeof isPromise;
    styleText: typeof styleText;
    parseArgs: typeof parseArgs;
    types: {
        isDate: typeof isDate;
        isRegExp: typeof isRegExp;
        isNativeError: typeof isNativeError;
        isError: typeof isNativeError;
        isMap: typeof isMap;
        isSet: typeof isSet;
        isPromise: typeof isPromise;
        isTypedArray: typeof isTypedArray;
        isUint8Array: typeof isUint8Array;
        isArrayBuffer: typeof isArrayBuffer;
        isDataView: typeof isDataView;
        isAnyArrayBuffer: typeof isAnyArrayBuffer;
        isBoxedPrimitive: typeof isBoxedPrimitive;
        isBooleanObject: typeof isBooleanObject;
        isNumberObject: typeof isNumberObject;
        isStringObject: typeof isStringObject;
        isSymbolObject: typeof isSymbolObject;
        isAsyncFunction: typeof isAsyncFunction;
        isGeneratorFunction: typeof isGeneratorFunction;
        isGeneratorObject: typeof isGeneratorObject;
        isProxy: typeof isProxy;
        isBuffer: typeof isBuffer;
    };
    toUSVString: typeof toUSVString;
    MIMEType: typeof MIMEType;
    MIMEParams: typeof MIMEParams;
    aborted: typeof aborted;
    transferableAbortController: typeof transferableAbortController;
    transferableAbortSignal: typeof transferableAbortSignal;
    getSystemErrorMap: typeof getSystemErrorMap;
    getSystemErrorName: typeof getSystemErrorName;
    getSystemErrorMessage: typeof getSystemErrorMessage;
    parseEnv: typeof parseEnv;
    diff: typeof diff;
    setTraceSigInt: typeof setTraceSigInt;
    getCallSites: typeof getCallSites;
    TextEncoder: {
        new (): TextEncoder;
        prototype: TextEncoder;
    };
    TextDecoder: {
        new (label?: string, options?: TextDecoderOptions): TextDecoder;
        prototype: TextDecoder;
    };
};
export default _default;
