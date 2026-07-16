/**
 * Doc-sync build pipeline (SPEC §4.3, spec/doc-sync.md).
 *
 * Fetches the Agent Reference snapshot, assembles it with the skills index and our platform
 * sections into one system prompt, hashes it, and stores it as an immutable version. Activation is
 * a SEPARATE step, so a failed build can never take generation down: the previous version stays
 * active and the user never notices.
 *
 * This is the ONLY place the platform talks to GitHub for docs. Generation itself has zero network
 * dependency on GitHub — a hard rule (SPEC §1.3 principle 3).
 */
import { createScopedLogger } from '~/utils/logger';
import identitySection from './sections/00-platform-identity.md?raw';
import actionProtocolSection from './sections/10-action-protocol.md?raw';
import hardConstraintsSection from './sections/20-hard-constraints.md?raw';
import projectSpecSection from './sections/25-project-spec.md?raw';
import selfHealingSection from './sections/30-self-healing.md?raw';
import skillUsageSection from './sections/40-skill-usage.md?raw';
import { githubJson, githubText } from './github';
import { AGENT_REPO, BASE_DOCS, DECLARATION_FILES, ON_DEMAND_BLOCKS, type DocSource } from './sources';
import { computeBuildHash, getPromptStore, sha256, type NewPromptVersion, type PromptVersionMeta } from './store';

const logger = createScopedLogger('doc-sync');

export interface BuildResult {
  status: 'built' | 'unchanged';

  /**
   * Metadata ONLY — never the prompt body. Both paths must agree on this: `unchanged` reads the
   * active version (which carries `content`) while `built` gets a meta back from the store, so
   * returning the read straight through made the admin refresh response ~150KB on one path and a few
   * hundred bytes on the other, for the same call.
   */
  version: PromptVersionMeta;
  sourceCommitSha: string;
  fetched: number;
}

/** Drop the body from a full version read, so `content` cannot ride out through a metadata field. */
function toMeta(version: PromptVersionMeta & { content?: string }): PromptVersionMeta {
  const { content: _content, ...meta } = version;
  return meta;
}

/**
 * Fetch one doc. A missing or empty doc FAILS THE BUILD — we never activate a partial prompt.
 * A silently-truncated system prompt is far worse than a stale one.
 */
async function fetchDoc(source: DocSource, token?: string): Promise<string> {
  let body: string;

  try {
    body = await githubText(source.url, token);
  } catch (error) {
    throw new Error(`doc-sync: ${source.path}: ${(error as Error).message}`);
  }

  if (!body.trim()) {
    throw new Error(`doc-sync: ${source.path} is empty`);
  }

  return body;
}

/** `main` HEAD of the agent repo — what makes a prompt version traceable back to a doc commit. */
async function fetchSourceCommitSha(token?: string): Promise<string> {
  const head = await githubJson<{ sha: string }>(`https://api.github.com/repos/${AGENT_REPO}/commits/main`, token);

  return head.sha;
}

function fence(source: DocSource, body: string): string {
  return [`<agent_reference path="${source.path}">`, body.trim(), `</agent_reference>`].join('\n');
}

/**
 * Assemble the base prompt.
 *
 * Order is load-bearing. The platform identity section comes FIRST because it must override the
 * Agent Reference's router index, which instructs the reader to go fetch sub-documents over the
 * network — an instruction that is both impossible (no network at generation time) and already
 * satisfied (the sub-docs are inlined right below it).
 */
export function assemblePrompt(docs: Array<{ source: DocSource; body: string }>, skillsIndex: string): string {
  return [
    identitySection.trim(),
    '# Babylon Toolkit Agent Reference (synced snapshot)',
    ...docs.map(({ source, body }) => fence(source, body)),
    skillsIndex.trim(),
    actionProtocolSection.trim(),
    hardConstraintsSection.trim(),

    /*
     * After the hard constraints, before self-healing: the project's own `SPEC.md` outranks the
     * agent's defaults but never the platform's non-negotiables (file zones, the play contract).
     */
    projectSpecSection.trim(),
    selfHealingSection.trim(),
    skillUsageSection.trim(),
  ]
    .filter(Boolean)
    .join('\n\n---\n\n');
}

export interface BuildOptions {
  /**
   * The skills index text (name + description + when-to-use per active skill), supplied by the
   * skills subsystem (§4.11). Passed in rather than imported so doc-sync stays independent of it.
   */
  skillsIndex: string;
  githubToken?: string;

  /** Build and store, but do not activate. Activation is always a separate, explicit step. */
  activate?: boolean;
}

export async function buildSystemPrompt(options: BuildOptions): Promise<BuildResult> {
  const { skillsIndex, githubToken, activate = true } = options;
  const store = getPromptStore();

  logger.info(`Building system prompt from ${AGENT_REPO}@main`);

  const sourceCommitSha = await fetchSourceCommitSha(githubToken);

  // Fetch everything before assembling anything — one missing doc must fail the whole build.
  const docs = await Promise.all(
    BASE_DOCS.map(async (source) => ({ source, body: await fetchDoc(source, githubToken) })),
  );

  const onDemand: Record<string, string> = {};
  await Promise.all(
    ON_DEMAND_BLOCKS.map(async (block) => {
      onDemand[block.id] = await fetchDoc(block, githubToken);
    }),
  );

  const declarations: Record<string, string> = {};
  await Promise.all(
    DECLARATION_FILES.map(async (decl) => {
      declarations[decl.id] = await fetchDoc(decl, githubToken);
    }),
  );

  const content = assemblePrompt(docs, skillsIndex);
  const fetched = docs.length + Object.keys(onDemand).length + Object.keys(declarations).length;

  const candidate: NewPromptVersion = {
    content,
    sourceCommitSha,
    skillsSetHash: sha256(skillsIndex),
    onDemand,
    declarations,
  };

  /*
   * The no-op is keyed on the WHOLE build, not on `contentHash`.
   *
   * On-demand blocks and declarations are fetched right here but persisted ONLY by `store.put()`,
   * which this early return skips. Keyed on `contentHash` (the base prompt alone), an edit confined
   * to a system doc — `training/components/*.md`, `shader-materials.md`, a declaration file — was
   * fetched, reported `ok: true, status: "unchanged"`, and then dropped on the floor: the active
   * version kept pointing at the old blobs and the agent served stale docs until something happened
   * to change a base doc. Nothing threw. Nothing broke. It was just quietly wrong.
   */
  const buildHash = computeBuildHash(candidate);
  const active = await store.getActive();

  if (active?.buildHash === buildHash) {
    /*
     * "Unchanged" is a real finding, so record it: this content is current as of THIS commit. The
     * version keeps the commit it was built from (immutable provenance) — without the observation,
     * `sourceCommitSha` drifts behind HEAD forever and reads as staleness, leaving no way to tell a
     * sync that never ran from a sync that ran and correctly found nothing to do.
     */
    await store.recordSeen(active.id, sourceCommitSha);

    logger.info(
      `Build unchanged (${buildHash.slice(0, 12)}) — keeping active version ${active.id}, ` +
        `confirmed current at ${sourceCommitSha.slice(0, 8)}`,
    );

    return { status: 'unchanged', version: toMeta((await store.get(active.id)) ?? active), sourceCommitSha, fetched };
  }

  const version = await store.put(candidate);

  if (activate) {
    await store.activate(version.id);
    version.isActive = true;
  }

  logger.info(
    `Built prompt version ${version.id} (${Math.round(version.baseBytes / 1024)}KB base, ` +
      `${Object.keys(onDemand).length} on-demand blocks, ${Object.keys(declarations).length} declarations)`,
  );

  return { status: 'built', version, sourceCommitSha, fetched };
}
