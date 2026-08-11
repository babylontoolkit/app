import type { ServerResponse } from "./http";
/**
 * Copy any HeadersInit into a bare `new Headers()` (guard "none"), which —
 * unlike Request/Response header lists — accepts every header including
 * Cookie, Host, Origin and Set-Cookie.
 */
export declare function toGuardlessHeaders(init?: HeadersInit | null): Headers;
/**
 * Node.js parity for the Fetch API in worker realms.
 *
 * Browsers enforce "forbidden header" guards inside the Request/Response
 * constructors: `new Request(url, {headers: {cookie}})` silently drops
 * Cookie/Host/Origin, and `new Response(body, {headers})` silently drops
 * Set-Cookie. Node (undici) has no such guards, so server frameworks that
 * round-trip Node requests through Fetch objects (Hono, SvelteKit adapters,
 * Fetch→Node HTTP bridges, ...) lose session cookies when run in a browser worker.
 *
 * This replaces the realm's Request/Response with subclasses whose `headers`
 * property is a guard-free Headers object, restoring Node semantics. Never
 * installed in Window realms (page code keeps native behavior).
 */
export declare function installNodeFetchClassParity(): void;
/**
 * Replace setResponse on Fetch→Node HTTP adapter modules (export pairs with
 * getRequest + setResponse). Native adapter implementations often iterate
 * response.headers in ways that drop multiple Set-Cookie values in worker
 * realms even after Headers parity is installed.
 */
export declare function patchFetchNodeAdapterExports(exports: Record<string, unknown>): void;
/** Make Fetch Headers iteration/get behave like Node for Set-Cookie (browser worker parity). */
export declare function installFetchHeadersSetCookieParity(): void;
export declare function collectSetCookies(headers: Headers): string[];
/** Convert Fetch API response headers to Node.js IncomingMessage header record. */
export declare function fetchHeadersToNodeRecord(headers: Headers): Record<string, string | string[]>;
/** Copy Fetch headers into another Headers object (Node.js Set-Cookie parity). */
export declare function copyFetchHeaders(target: Headers, source: HeadersInit | Headers | undefined): void;
/** Build Fetch Headers from a Node-style header record (Set-Cookie arrays preserved). */
export declare function recordToFetchHeaders(headers: Record<string, string | string[] | undefined>): Headers;
/** Copy a Fetch Response onto a Node.js-style ServerResponse (Node http parity). */
export declare function setFetchResponse(res: ServerResponse, response: Response): Promise<void>;
