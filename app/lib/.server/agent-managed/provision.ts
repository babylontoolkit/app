/**
 * Managed Agents provisioning (`_specs/managed-agents-engine_plan.md` T3, D4, D10, D12).
 *
 * An ADMIN action (Settings → Admin → Agent repository → "Provision managed agent", beside Synchronize)
 * that turns the active prompt version into a Managed Agents agent:
 *
 *   - the system prompt (`system-prompt.ts`) and the custom tool definitions (`tools.ts`);
 *   - the model + effort from config (D10) — one agent per `${model}:${effort}`;
 *   - the synced `bt-*` skills, through the Skills API (the skill store's `listActive` already honours
 *     `skills/exclusions.ts` at its read seam, so an excluded skill is never even read here);
 *   - the Agent Reference (`reference.md`, `references/**`, `training/**` of `babylontoolkit/agent` at the
 *     version's `sourceCommitSha`) uploaded once per SHA through the Files API (D12). Those are SESSION
 *     resources, not agent fields, so they are recorded for T5 to mount under `/workspace/agent/<rel>`.
 *
 * The record lands ON the prompt version (`PromptStore.recordManagedAgent`). There is no second store:
 * a previous version's record is how a new version finds the agent, skills and uploads to reuse.
 *
 * 🔴 HASH-SKIPPED (the T3 acceptance). `hash` covers every input; an unchanged hash makes ZERO Anthropic
 * calls — not a cheap call, none — and a new prompt version whose inputs did not change inherits the
 * previous record rather than minting an agent version. Within a changed run, each piece is skipped on
 * its own key: reference files by SHA, a skill by its bundle hash, `agents.update` by the definition hash.
 *
 * GitHub is read here, at provisioning time, which SPEC §4.3 permits (an admin action, like doc-sync);
 * generation still never touches GitHub — T5 reads the recorded file ids.
 */
import { createHash } from 'node:crypto';
import Anthropic, { toFile } from '@anthropic-ai/sdk';
import type { BetaManagedAgentsModel } from '@anthropic-ai/sdk/resources/beta/agents/agents';
import { NotConfiguredError } from '~/lib/.server/env';
import { getPlatformConfig } from '~/lib/.server/agent/config';
import { githubFetch, githubJson } from '~/lib/.server/prompt/github';
import { AGENT_REPO } from '~/lib/.server/prompt/sources';
import { getPromptStore, type PromptStore } from '~/lib/.server/prompt/store';
import { getSkillStore, type SkillVersion } from '~/lib/.server/skills/store';
import { createScopedLogger } from '~/utils/logger';
import { getManagedClient, getManagedEngineConfig, type ManagedEngineConfig } from './config';
import type { ManagedAgentRecord, ManagedReferenceFile, ManagedSkillRef } from './record';
import { buildManagedSystemPrompt } from './system-prompt';
import { MANAGED_BUILTIN_TOOLSET, MANAGED_CUSTOM_TOOLS } from './tools';

export type { ManagedAgentRecord, ManagedReferenceFile, ManagedSkillRef } from './record';

const logger = createScopedLogger('managed-provision');

/** Parallel uploads — enough to make ~100 reference files quick, few enough not to trip a rate limit. */
const UPLOAD_CONCURRENCY = 6;

/** Not docs: never uploaded as reference files (the agent reads text with `read`/`grep`). */
const BINARY_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'ico',
  'bmp',
  'tga',
  'psd',
  'wasm',
  'glb',
  'gltf',
  'bin',
  'fbx',
  'obj',
  'zip',
  'gz',
  'tgz',
  'rar',
  '7z',
  'mp3',
  'wav',
  'ogg',
  'mp4',
  'webm',
  'mov',
  'pdf',
  'ttf',
  'otf',
  'woff',
  'woff2',
  'exe',
  'dll',
  'so',
  'dylib',
]);

export function managedAgentKey(model: string, effort: string): string {
  return `${model}:${effort}`;
}

/** True for the files D12 mounts: `reference.md`, `references/**`, `training/**` — text only, no dotfiles. */
export function isReferenceDocPath(rel: string): boolean {
  if (rel !== 'reference.md' && !rel.startsWith('references/') && !rel.startsWith('training/')) {
    return false;
  }

  if (rel.split('/').some((segment) => segment.startsWith('.') || segment === '')) {
    return false;
  }

  const dot = rel.lastIndexOf('.');
  const ext = dot === -1 ? '' : rel.slice(dot + 1).toLowerCase();

  return !BINARY_EXTENSIONS.has(ext);
}

/** JSON with object keys sorted at every depth — the only correct input to a hash of a structure. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }

  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }

  return JSON.stringify(value ?? null);
}

function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

// ─── the Agent Reference source (GitHub, injectable for specs) ───────────────────────────────────

export interface ReferenceSource {
  /** Every file path in the repo at `sha` (the caller filters with `isReferenceDocPath`). */
  list(sha: string): Promise<string[]>;
  read(sha: string, rel: string): Promise<Uint8Array>;
}

export function githubReferenceSource(token?: string): ReferenceSource {
  return {
    async list(sha) {
      const tree = await githubJson<{ tree: Array<{ path: string; type: string }>; truncated: boolean }>(
        `https://api.github.com/repos/${AGENT_REPO}/git/trees/${sha}?recursive=1`,
        token,
      );

      if (tree.truncated) {
        throw new Error(`${AGENT_REPO} tree was truncated by the GitHub API — cannot list the reference reliably`);
      }

      return tree.tree.filter((entry) => entry.type === 'blob').map((entry) => entry.path);
    },
    async read(sha, rel) {
      // Pinned to the commit, so a push mid-upload cannot give us a torn reference.
      const url = `https://raw.githubusercontent.com/${AGENT_REPO}/${sha}/${rel.split('/').map(encodeURIComponent).join('/')}`;
      const response = await githubFetch(url, 'application/octet-stream', token);

      if (!response.ok) {
        throw new Error(`${url} → HTTP ${response.status} ${response.statusText}`);
      }

      return new Uint8Array(await response.arrayBuffer());
    },
  };
}

let testReferenceSource: ReferenceSource | undefined;

/** Test seam: specs must never reach GitHub. */
export function setReferenceSourceForTests(source: ReferenceSource | undefined): void {
  testReferenceSource = source;
}

// ─── skill bundles ───────────────────────────────────────────────────────────────────────────────

interface SkillBundle {
  name: string;
  files: Array<{ path: string; bytes: Uint8Array }>;
  contentHash: string;
}

/**
 * The store keeps SKILL.md with its frontmatter STRIPPED (`body`), and the Skills API needs it back:
 * the platform indexes `name` + `description` from it. The description is JSON-quoted, which is valid
 * YAML for any text (a colon in an unquoted description would not be).
 */
function skillMarkdown(skill: SkillVersion): string {
  const lines = ['---', `name: ${skill.name}`, `description: ${JSON.stringify(skill.description)}`];

  if (skill.dependencies.length > 0) {
    lines.push(`dependencies: ${skill.dependencies.join(', ')}`);
  }

  return `${lines.join('\n')}\n---\n\n${skill.body}`;
}

async function readSkillBundles(): Promise<SkillBundle[]> {
  const store = getSkillStore();
  const skills = await store.listActive();
  const encoder = new TextEncoder();
  const bundles: SkillBundle[] = [];

  for (const skill of [...skills].sort((a, b) => a.name.localeCompare(b.name))) {
    const files = [{ path: `${skill.name}/SKILL.md`, bytes: encoder.encode(skillMarkdown(skill)) }];

    for (const resourcePath of [...skill.resourcePaths].sort()) {
      const body = await store.readResource(skill.name, resourcePath);

      if (body !== null) {
        files.push({ path: `${skill.name}/${resourcePath}`, bytes: encoder.encode(body) });
      }
    }

    bundles.push({
      name: skill.name,
      files,
      contentHash: sha256(canonicalJson(files.map((file) => ({ path: file.path, sha: sha256(file.bytes) })))),
    });
  }

  return bundles;
}

// ─── provisioning ────────────────────────────────────────────────────────────────────────────────

export interface ProvisionOptions {
  context: unknown;

  /** Skip the hash check and push a new agent version even when nothing changed. Uploads still reuse by key. */
  force?: boolean;
}

export interface ProvisionResult {
  /** What happened to the AGENT: a first version, a new version, or nothing. */
  status: 'created' | 'updated' | 'unchanged';
  key: string;
  promptVersionId: string;
  agentId: string;
  agentVersion: number;
  environmentId: string;
  referenceFiles: number;
  skills: number;

  /** Files and skill versions actually uploaded by THIS run (0 on a skip). */
  uploadedFiles: number;
  uploadedSkills: number;
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));

  return results;
}

/** The newest record for `key` on any version other than `excludeId` — how a new version finds what to reuse. */
async function latestRecord(
  store: PromptStore,
  key: string,
  excludeId?: string,
): Promise<{ record: ManagedAgentRecord; versionId: string } | null> {
  let best: { record: ManagedAgentRecord; versionId: string } | null = null;

  for (const meta of await store.list()) {
    const record = meta.managedAgents?.[key];

    if (!record || meta.id === excludeId) {
      continue;
    }

    if (!best || record.provisionedAt > best.record.provisionedAt) {
      best = { record, versionId: meta.id };
    }
  }

  return best;
}

function result(
  status: ProvisionResult['status'],
  record: ManagedAgentRecord,
  promptVersionId: string,
  uploadedFiles = 0,
  uploadedSkills = 0,
): ProvisionResult {
  return {
    status,
    key: record.key,
    promptVersionId,
    agentId: record.agentId,
    agentVersion: record.agentVersion,
    environmentId: record.environmentId,
    referenceFiles: record.referenceFiles.length,
    skills: record.skills.length,
    uploadedFiles,
    uploadedSkills,
  };
}

async function uploadReference(
  client: Anthropic,
  source: ReferenceSource,
  sha: string,
): Promise<ManagedReferenceFile[]> {
  const paths = (await source.list(sha)).filter(isReferenceDocPath).sort();

  if (!paths.includes('reference.md')) {
    throw new Error(
      `${AGENT_REPO}@${sha.slice(0, 8)} has no reference.md — refusing to provision a reference without its index`,
    );
  }

  return mapLimit(paths, UPLOAD_CONCURRENCY, async (rel) => {
    const bytes = await source.read(sha, rel);
    const uploaded = await client.beta.files.upload({ file: await toFile(bytes, rel.slice(rel.lastIndexOf('/') + 1)) });

    return { rel, fileId: uploaded.id };
  });
}

async function uploadSkill(client: Anthropic, bundle: SkillBundle, prior?: ManagedSkillRef): Promise<ManagedSkillRef> {
  const files = await Promise.all(bundle.files.map((file) => toFile(file.bytes, file.path)));

  if (prior) {
    const version = await client.beta.skills.versions.create(prior.skillId, { files });
    return { name: bundle.name, skillId: prior.skillId, version: version.id, contentHash: bundle.contentHash };
  }

  const skill = await client.beta.skills.create({ files, display_name: bundle.name });

  return { name: bundle.name, skillId: skill.id, version: skill.latest_version_id, contentHash: bundle.contentHash };
}

function agentDefinition(config: ManagedEngineConfig, system: string, skills: ManagedSkillRef[]) {
  return {
    name: `btk-app-builder-${config.model}-${config.effort}`,
    model: { id: config.model as BetaManagedAgentsModel, effort: config.effort },
    system,
    tools: [MANAGED_BUILTIN_TOOLSET, ...MANAGED_CUSTOM_TOOLS],
    skills: skills.map((skill) => ({ type: 'custom' as const, skill_id: skill.skillId, version: skill.version })),
  };
}

/**
 * Create or update the managed agent from the active prompt version. Throws `NotConfiguredError` (503 at
 * the route) when the Anthropic key is missing or there is no prompt version yet — before any client call.
 */
export async function provisionManagedAgent(options: ProvisionOptions): Promise<ProvisionResult> {
  const { context, force = false } = options;
  const config = getManagedEngineConfig(context);
  const key = managedAgentKey(config.model, config.effort);
  const store = getPromptStore();
  const active = await store.getActive();

  if (!active) {
    throw new NotConfiguredError(
      'The system prompt',
      'Press Synchronize under Agent repository in the Admin panel before provisioning the managed agent.',
    );
  }

  const system = buildManagedSystemPrompt();
  const bundles = await readSkillBundles();
  const referenceSha = active.sourceCommitSha;
  const hash = sha256(
    canonicalJson({
      model: config.model,
      effort: config.effort,
      system,
      tools: [MANAGED_BUILTIN_TOOLSET, ...MANAGED_CUSTOM_TOOLS],
      skills: bundles.map((bundle) => ({ name: bundle.name, contentHash: bundle.contentHash })),
      referenceSha,
      environmentId: config.environmentId ?? null,
    }),
  );

  const current = active.managedAgents?.[key];

  if (!force && current?.hash === hash) {
    return result('unchanged', current, active.id);
  }

  const prior = current ?? (await latestRecord(store, key, active.id))?.record;

  // A new prompt version whose inputs did not move inherits the agent — no new agent version (T3 acceptance).
  if (!force && prior?.hash === hash) {
    await store.recordManagedAgent(active.id, prior);
    return result('unchanged', prior, active.id);
  }

  const client = getManagedClient(context);

  const environmentId =
    config.environmentId ??
    prior?.environmentId ??
    (
      await client.beta.environments.create({
        name: 'btk-app-builder',
        config: { type: 'cloud', networking: { type: 'limited', allowed_hosts: [] } },
      })
    ).id;

  let uploadedFiles = 0;
  let referenceFiles: ManagedReferenceFile[];

  if (prior && prior.referenceSha === referenceSha && prior.referenceFiles.length > 0) {
    referenceFiles = prior.referenceFiles;
  } else {
    const source = testReferenceSource ?? githubReferenceSource(getPlatformConfig(context).githubToken);
    referenceFiles = await uploadReference(client, source, referenceSha);
    uploadedFiles = referenceFiles.length;
  }

  let uploadedSkills = 0;
  const skills: ManagedSkillRef[] = [];

  for (const bundle of bundles) {
    const priorRef = prior?.skills.find((skill) => skill.name === bundle.name);

    if (priorRef && priorRef.contentHash === bundle.contentHash) {
      skills.push(priorRef);
      continue;
    }

    skills.push(await uploadSkill(client, bundle, priorRef));
    uploadedSkills++;
  }

  const definition = agentDefinition(config, system, skills);
  const agentHash = sha256(canonicalJson(definition));

  let status: ProvisionResult['status'];
  let agentId: string;
  let agentVersion: number;

  if (!prior) {
    const agent = await client.beta.agents.create(definition);
    status = 'created';
    agentId = agent.id;
    agentVersion = agent.version;
  } else if (!force && prior.agentHash === agentHash) {
    // Only session resources moved (reference files, environment) — the agent itself is unchanged.
    status = 'unchanged';
    agentId = prior.agentId;
    agentVersion = prior.agentVersion;
  } else {
    /*
     * `version` guards against overwriting a change made elsewhere (the console, a second admin); a
     * forced run applies unconditionally, which is the way out of that conflict.
     */
    const agent = await client.beta.agents.update(prior.agentId, {
      ...definition,
      ...(force ? {} : { version: prior.agentVersion }),
    });
    status = 'updated';
    agentId = agent.id;
    agentVersion = agent.version;
  }

  const record: ManagedAgentRecord = {
    key,
    agentId,
    agentVersion,
    hash,
    agentHash,
    environmentId,
    model: config.model,
    effort: config.effort,
    referenceSha,
    referenceFiles,
    skills,
    provisionedAt: new Date().toISOString(),
  };

  await store.recordManagedAgent(active.id, record);

  logger.info(
    `Managed agent ${status}: ${agentId} v${agentVersion} (${key}) from ${active.id}; ` +
      `${uploadedFiles} reference file(s) and ${uploadedSkills} skill(s) uploaded`,
  );

  return result(status, record, active.id, uploadedFiles, uploadedSkills);
}

export interface ManagedAgentStatus {
  key: string;
  activeVersionId: string | null;

  /** The record a session should start on: the active version's, else the newest earlier one. */
  record: ManagedAgentRecord | null;

  /** True when `record` was provisioned from the ACTIVE prompt version. */
  current: boolean;
}

/** For the Admin panel and for T5: which agent the managed engine runs on right now. Makes no client call. */
export async function getManagedAgentStatus(context: unknown): Promise<ManagedAgentStatus> {
  const config = getManagedEngineConfig(context);
  const key = managedAgentKey(config.model, config.effort);
  const store = getPromptStore();
  const active = await store.getActive();
  const own = active?.managedAgents?.[key];

  if (own) {
    return { key, activeVersionId: active?.id ?? null, record: own, current: true };
  }

  const earlier = await latestRecord(store, key, active?.id);

  return { key, activeVersionId: active?.id ?? null, record: earlier?.record ?? null, current: false };
}

/**
 * The agent a managed session starts on (T5): agent id + version, environment, and the reference files
 * to mount. Falls back to an earlier prompt version's agent when the active version has not been
 * provisioned yet (a Synchronize that preceded a Provision) — that agent still works, it just reads the
 * previous docs. `null` means "never provisioned"; throws `NotConfiguredError` without a key.
 */
export async function getManagedAgentRecord(context: unknown): Promise<ManagedAgentRecord | null> {
  return (await getManagedAgentStatus(context)).record;
}
