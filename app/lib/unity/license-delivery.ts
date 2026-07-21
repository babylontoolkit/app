/**
 * Unity Project Licenser — client-side delivery of the generated `license.json` (SPEC §4.18).
 *
 * The server (T4 route) builds the license object and hands it back over `/api/projects/:id/unity-license`;
 * THIS module puts it where the user needs it, three ways, none of which spend credits or run a
 * generation:
 *
 *   (a) `writeLicenseToWebProject` — write `/license.json` into the WebContainer so it rides the
 *       user's repo on the next save (the `media/tasks.ts` `deliverBytes` pattern).
 *   (b) `dropLicenseIntoUnity` — best-effort MCP write into the OPEN local Unity project at
 *       `Assets/[Config]/license.json`, via a tool discovered from the live Unity bridge tool set.
 *       A missing tool, a disconnected bridge, or a tool error is a LOUD structured failure
 *       (`{ ok: false, reason }`) — NEVER a silent success (the caller shows manual instructions).
 *   (c) `downloadLicense` — a plain browser download named `license.json` (the EventLogs pattern).
 *
 * The Unity drop goes through `callUnityTool` — the ordinary §4.14 client-executor path — so the
 * reserved `unity` server-name routing is untouched. There is no platform↔project file channel here;
 * the drop is an MCP asset write into the user's own editor, which the "no file channel" rule permits.
 */
import { callUnityTool, unityConnectionAtom, unityToolsAtom } from '~/lib/stores/unityBridge';
import type { McpTool } from '~/lib/mcp/webcontainer-bridge';
import { workbenchStore } from '~/lib/stores/workbench';
import { WORK_DIR } from '~/utils/constants';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('unity-license-delivery');

/**
 * The `license.json` object shape (mirror of the server's `UnityLicense`, declared here so this
 * client module never imports from `~/lib/.server/**`). The delivery paths only serialise it, so the
 * exact field set is documentation — an extra field would round-trip harmlessly.
 */
export interface UnityLicense {
  licensee: string;
  product: string;
  project: string;
  secret: string;
  trial: boolean;
  plan: string;
  org: string;
  key: string;
  s1: string;
  s2: string;
  expires: string;
}

/** Where the license lands inside the web project — root-relative, matches the opaque marker (T6). */
export const WEB_LICENSE_PATH = 'license.json';

/** Where the license lands inside the open Unity project (a Unity-side folder, created if needed). */
export const UNITY_LICENSE_PATH = 'Assets/[Config]/license.json';

/** Pretty-print once — both the web write and the Unity drop deliver identical, human-readable JSON. */
function serialize(license: UnityLicense): string {
  return JSON.stringify(license, null, 2);
}

/**
 * Write `license.json` into the root of the WebContainer project. Returns whether the write landed;
 * the file then travels with every egress path (ZIP, GitHub push, share build) and is opaque to the
 * model (T6).
 */
export async function writeLicenseToWebProject(license: UnityLicense): Promise<boolean> {
  try {
    const written = await workbenchStore.createFile(`${WORK_DIR}/${WEB_LICENSE_PATH}`, serialize(license));

    if (written) {
      logger.info(`Wrote ${WEB_LICENSE_PATH} into the web project.`);
    } else {
      logger.error(`Failed to write ${WEB_LICENSE_PATH} into the web project.`);
    }

    return written;
  } catch (error) {
    logger.error(`Failed to write ${WEB_LICENSE_PATH}: ${(error as Error).message}`);
    return false;
  }
}

/** The outcome of an attempted Unity drop — a success or a NAMED failure, never an ambiguous result. */
export type UnityDropResult = { ok: true; tool: string } | { ok: false; reason: string };

const WRITE_HINTS = ['create', 'write', 'add', 'save', 'import', 'update', 'manage', 'set'];
const TARGET_HINTS = ['asset', 'file', 'script', 'text'];

/** Property-name candidates for "where to write" and "what to write", best match first. */
const PATH_KEY_HINTS = ['path', 'asset_path', 'assetpath', 'filepath', 'file', 'destination', 'target'];
const CONTENT_KEY_HINTS = ['contents', 'content', 'text', 'data', 'source', 'body', 'value'];

/**
 * Score a tool for how well it fits "create a file/asset in the Unity project". A candidate must have
 * both a write-verb hint and a target-noun hint in its name; `asset` scores highest (the CoplayDev
 * unity-mcp asset tools). Returns -1 for a non-candidate.
 */
function scoreWriteTool(tool: McpTool): number {
  const name = tool.name.toLowerCase();
  const hasWrite = WRITE_HINTS.some((h) => name.includes(h));
  const hasTarget = TARGET_HINTS.some((h) => name.includes(h));

  if (!hasWrite || !hasTarget) {
    return -1;
  }

  let score = 1;

  if (name.includes('asset')) {
    score += 2;
  }

  if (name.includes('create') || name.includes('write')) {
    score += 1;
  }

  return score;
}

/** Pull `{ properties }` out of a JSON-schema-ish `inputSchema`, or undefined if it has none. */
function schemaProperties(schema: unknown): Record<string, unknown> | undefined {
  if (schema && typeof schema === 'object' && 'properties' in schema) {
    const props = (schema as { properties?: unknown }).properties;

    if (props && typeof props === 'object') {
      return props as Record<string, unknown>;
    }
  }

  return undefined;
}

/** Choose the schema property whose name best matches one of `hints`, preferring earlier hints. */
function pickKey(properties: Record<string, unknown> | undefined, hints: string[], fallback: string): string {
  if (!properties) {
    return fallback;
  }

  const names = Object.keys(properties);

  for (const hint of hints) {
    const exact = names.find((n) => n.toLowerCase() === hint);

    if (exact) {
      return exact;
    }
  }

  for (const hint of hints) {
    const partial = names.find((n) => n.toLowerCase().includes(hint));

    if (partial) {
      return partial;
    }
  }

  return fallback;
}

/**
 * Best-effort drop of the license into the connected Unity project's `Assets/[Config]/license.json`.
 *
 * Returns a structured result: `{ ok: true }` only when a discovered write-tool accepted the call;
 * otherwise `{ ok: false, reason }`. A disconnected bridge returns WITHOUT calling any tool — the drop
 * is never attempted (and never a silent success) when there is nothing to talk to.
 */
export async function dropLicenseIntoUnity(license: UnityLicense): Promise<UnityDropResult> {
  const connection = unityConnectionAtom.get();

  if (connection.status !== 'connected') {
    return { ok: false, reason: 'The Unity Exporter is not connected.' };
  }

  const tools = unityToolsAtom.get();
  const candidate = tools
    .map((tool) => ({ tool, score: scoreWriteTool(tool) }))
    .filter((c) => c.score >= 0)
    .sort((a, b) => b.score - a.score)[0]?.tool;

  if (!candidate) {
    return {
      ok: false,
      reason: 'No asset-writing tool is available from the connected Unity Editor.',
    };
  }

  const properties = schemaProperties(candidate.inputSchema);
  const pathKey = pickKey(properties, PATH_KEY_HINTS, 'path');
  const contentKey = pickKey(properties, CONTENT_KEY_HINTS, 'contents');

  const args: Record<string, unknown> = {
    [pathKey]: UNITY_LICENSE_PATH,
    [contentKey]: serialize(license),
  };

  // Action-dispatched tools (e.g. `manage_asset`) need to be told this is a create/write.
  if (properties && Object.keys(properties).some((n) => n.toLowerCase() === 'action')) {
    args.action = 'create';
  }

  try {
    await callUnityTool(candidate.name, args);
    logger.info(`Dropped license into Unity via "${candidate.name}" → ${UNITY_LICENSE_PATH}.`);

    return { ok: true, tool: candidate.name };
  } catch (error) {
    const reason = (error as Error).message || 'The Unity tool call failed.';
    logger.error(`Unity license drop failed via "${candidate.name}": ${reason}`);

    return { ok: false, reason };
  }
}

/** Save the license to the user's machine as `license.json` (the EventLogs download pattern). */
export function downloadLicense(license: UnityLicense): void {
  const blob = new Blob([serialize(license)], { type: 'application/json' });
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = WEB_LICENSE_PATH;
  document.body.appendChild(a);
  a.click();
  window.URL.revokeObjectURL(url);
  document.body.removeChild(a);
}
