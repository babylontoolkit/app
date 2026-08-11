import { Worker as NodeWorker } from "node:worker_threads";
import type { HostWorker } from "../types";
/**
 * Bootstrap that runs inside worker_threads and presents a browser Worker
 * `self` surface so the existing IIFE process-worker bundle can exec as-is.
 */
export declare function buildNodeWorkerEvalBootstrap(): string;
export declare function wrapNodeWorker(nodeWorker: NodeWorker): HostWorker;
export declare function spawnNodeEvalWorker(source: string, name?: string): HostWorker;
