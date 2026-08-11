import type { NextRequest, NextResponse as NextResponseType } from "next/server";
/** Drop-in matcher for `export const config = { matcher: nodepodMatcher }`. */
export declare const nodepodMatcher = "/__sw__.js";
/**
 * Route handler for `app/__sw__.js/route.ts`.
 *
 * ```ts
 * export { GET } from '@scelar/nodepod/next';
 * ```
 */
export declare function GET(): Promise<NextResponseType>;
/**
 * Composable handler for Next 16's `proxy.ts` or Next <=15's `middleware.ts`.
 * Returns a response for the SW path, or `null` so the caller's own logic
 * can take over.
 *
 * Also exported as `nodepodMiddleware` for projects still on Next <=15.
 */
export declare function nodepodProxy(req: NextRequest): Promise<NextResponseType | null>;
/** Alias of {@link nodepodProxy} for Next <=15 (`middleware.ts`). */
export declare const nodepodMiddleware: typeof nodepodProxy;
