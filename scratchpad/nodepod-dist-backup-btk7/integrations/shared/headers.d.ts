export declare const DEFAULT_SW_PATH = "/__sw__.js";
/**
 * Headers for the nodepod service worker response.
 *
 * Content-Type must be a JS type or browsers silently refuse to register
 * the SW (the common failure mode is SPA dev servers serving text/html
 * as a fallback and quietly breaking things).
 *
 * Service-Worker-Allowed: / lets the SW control the whole origin even if
 * the script itself lives under a nested path.
 *
 * Cache-Control: no-cache pairs with the `?v=${Date.now()}` cache-buster
 * the SDK appends on register(), so upgrades don't get a stale SW.
 */
export declare function swResponseHeaders(): Record<string, string>;
