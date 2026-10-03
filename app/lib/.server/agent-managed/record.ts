/**
 * The provisioning record of a Managed Agents agent (`_specs/managed-agents-engine_plan.md` T3).
 *
 * Stored ON the prompt version it was provisioned from (`PromptStore.recordManagedAgent`), keyed by
 * `${model}:${effort}` (D10 — each tier is its own provisioned agent of the same definition). Type-only
 * on purpose: `prompt/store.ts` imports it, and a value import from this directory into the prompt store
 * would drag the Anthropic SDK into every reader of the prompt.
 *
 * Everything a session needs (T5) is here: the agent id + version to start it on, the environment, and
 * the reference files to mount under `/workspace/agent/<rel>` (D12).
 */
import type { EffortLevel } from '~/lib/modules/llm/capabilities';

export interface ManagedReferenceFile {
  /** Path inside the Agent Reference repo, e.g. `references/web-app-builder.md`. Mounted at `/workspace/agent/<rel>`. */
  rel: string;
  fileId: string;
}

export interface ManagedSkillRef {
  name: string;
  skillId: string;

  /** The Skills API version id the agent pins. */
  version: string;

  /** sha256 of the bundle we uploaded — an unchanged bundle is never uploaded twice. */
  contentHash: string;
}

export interface ManagedAgentRecord {
  /** `${model}:${effort}`. */
  key: string;
  agentId: string;
  agentVersion: number;

  /** Hash of every INPUT (model, effort, system, tools, skill bundles, reference SHA, environment) — the skip key. */
  hash: string;

  /** Hash of the agent DEFINITION as sent (model, effort, system, tools, skill refs) — decides whether `agents.update` runs. */
  agentHash: string;
  environmentId: string;
  model: string;
  effort: EffortLevel;

  /** The Agent Reference commit the reference files were uploaded from. */
  referenceSha: string;
  referenceFiles: ManagedReferenceFile[];
  skills: ManagedSkillRef[];
  provisionedAt: string;
}
