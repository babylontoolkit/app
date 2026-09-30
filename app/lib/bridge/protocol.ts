/**
 * Unity Bridge wire protocol — shared by the server and (as a CommonJS port) the Desktop Agent.
 *
 * Spec: `_specs/unity-bridge-local-gltf_spec.md` B4/B6/B7.
 *
 * The Desktop Agent carries a CommonJS port of tiers/validate in `lib/bridge/policy.js` (D3) — change
 * both, and both test tables, together.
 *
 * This module is client-safe: it imports nothing outside `app/lib/bridge/`.
 */

export const BRIDGE_POLL_HOLD_MS = 25_000;
export const BRIDGE_PRESENCE_MS = 45_000;
export const BRIDGE_PICKUP_TIMEOUT_MS = 30_000;
export const BRIDGE_SYNC_WAIT_MS = 60_000;
export const BRIDGE_JOB_WAIT_MAX_S = 90;
export const BRIDGE_CONSENT_TIMEOUT_MS = 120_000;
export const BRIDGE_JOB_RETENTION_MS = 600_000;
export const BRIDGE_LAST_SEEN_WRITE_MS = 60_000;
export const BRIDGE_MAX_RESULT_CHARS = 20_000;
export const BRIDGE_MAX_IMAGE_BASE64 = 400_000;
export const BRIDGE_MAX_CAPTURE_PX = 1024;
export const BRIDGE_TOOLKIT_MIN_VERSION = '9.25.1';
export const BRIDGE_PROTOCOL_VERSION = 1;

export type BridgeOperation =
  | { kind: 'unity.list'; query?: string }
  | { kind: 'unity.command'; name: string; params: Record<string, unknown> }
  | { kind: 'unity.cli'; args: string[] }
  | { kind: 'unity.script'; source: string; entry: string }
  | { kind: 'unity.capture'; view: 'game' | 'scene'; width: number; height: number }
  | { kind: 'unity.editor'; action: 'status' | 'open' | 'close' }
  | { kind: 'devserver.start'; port?: number; auto?: boolean }
  | { kind: 'devserver.status' }
  | { kind: 'blender.script'; source: string; inputs: string[]; outputs: string[]; timeoutSeconds: number };

export interface BridgeUnityProject {
  key: string;
  name: string;
  productGuid?: string;
  unityVersion?: string;
  toolkitVersion?: string;
  pipelineVersion?: string;
}

export interface BridgeDevServerInfo {
  running: boolean;
  origin?: string;
  root?: string;
  project?: string;
  listen?: 'loopback' | 'all';
  scenes?: string[];
}

export interface BridgeHello {
  protocol: number; // BRIDGE_PROTOCOL_VERSION
  helperVersion: string;
  os: 'darwin' | 'win32' | 'linux';
  unityCli?: { path: string; version: string };
  blender?: { path: string; version: string };
  unityProjects: BridgeUnityProject[];
  devServer?: BridgeDevServerInfo; // for the FIRST unity project only
  scriptsDisabledLocally: boolean; // --no-scripts
}

export interface BridgeDispatch {
  jobId: string;
  op: BridgeOperation;
  unityProjectKey: string;
  allowScripts: boolean;
  consentGranted: boolean;
}

export interface BridgeCancel {
  jobId: string;
  cancel: true;
}

export interface BridgePollResponse {
  jobs: BridgeDispatch[];
  cancels: BridgeCancel[];
}

export interface BridgeResultPayload {
  ok: boolean;
  text: string; // already capped by the helper (capText)
  image?: { base64: string; mimeType: 'image/png' };
  exitCode?: number;
}

export type BridgeJobEvent =
  | { jobId: string; type: 'started' }
  | { jobId: string; type: 'progress'; line: string }
  | { jobId: string; type: 'final'; result: BridgeResultPayload }
  | { jobId: string; type: 'refused'; reason: string }; // helper refused BEFORE running (tier/path/guard) → nothing ran

export type BridgeJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'refused' | 'cancelled';

/** Keep the TAIL; announce truncation. */
export function capText(text: string, max = BRIDGE_MAX_RESULT_CHARS): string {
  return text.length <= max ? text : `…(earlier output truncated)\n${text.slice(text.length - max)}`;
}
