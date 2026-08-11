import type { RequestProxy } from "../../request-proxy";
import type { HttpIngress } from "../types";
export interface LocalHttpIngressOptions {
    proxy: RequestProxy;
    /** Bind address. Default 127.0.0.1 */
    host?: string;
    /** Port; 0 = ephemeral. Default 0 */
    port?: number;
}
/**
 * Real localhost HTTP server that forwards `/__virtual__/{instanceId}/{port}/...`
 * into RequestProxy.handleRequest — Node headless equivalent of the SW bridge.
 */
export declare function createLocalHttpIngress(opts: LocalHttpIngressOptions): HttpIngress;
