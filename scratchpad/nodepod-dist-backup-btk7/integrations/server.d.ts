import { Buffer } from "node:buffer";
import { DEFAULT_SW_PATH } from "./shared/headers";
export { DEFAULT_SW_PATH };
export declare function getServiceWorkerSource(): Promise<string>;
/**
 * Fetch-API handler. The caller is responsible for only routing the SW
 * path here, so we don't bother looking at the request.
 *
 * @example
 *   // Hono
 *   app.get('/__sw__.js', () => serveSW())
 *
 *   // Next.js app/__sw__.js/route.ts
 *   export async function GET() { return serveSW() }
 */
export declare function serveSW(_req?: Request): Promise<Response>;
export interface NodeServeSWResult {
    body: Buffer;
    headers: Record<string, string>;
    /** Same as headers["Content-Type"], just exposed inline for convenience. */
    contentType: string;
}
/**
 * Node-native handler for Express / Fastify / bare http.createServer.
 *
 * @example
 *   app.get('/__sw__.js', async (_req, res) => {
 *     const { body, headers } = await serveSWNode();
 *     for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
 *     res.status(200).send(body);
 *   });
 */
export declare function serveSWNode(): Promise<NodeServeSWResult>;
