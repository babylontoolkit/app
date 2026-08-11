/** In-memory cookie jar for virtual dev-server origins (instance + port). */
export type CookieRecord = {
    value: string;
    path: string;
    expires: number | null;
};
export declare function cookieJarKey(instanceId: string, serverPort: number | string): string;
export declare function parseSetCookie(raw: string): {
    name: string;
    rec: CookieRecord;
} | null;
export declare function cookiePathMatches(requestPath: string, cookiePath: string): boolean;
export declare function buildCookieHeader(jar: Map<string, CookieRecord> | undefined, path: string): string;
export declare function mergeCookieHeaders(browserCookie: string | undefined, jarCookie: string): string;
export declare class VirtualCookieJar {
    private _jars;
    store(instanceId: string, serverPort: number | string, setCookieValue: string | string[] | undefined): void;
    cookieHeader(instanceId: string, serverPort: number | string, path: string): string;
    clearInstance(instanceId: string): void;
    clearAll(): void;
}
