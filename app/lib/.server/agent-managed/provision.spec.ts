/**
 * Managed agent provisioning (`_specs/managed-agents-engine_plan.md` T3).
 *
 * The acceptance is an ABSENCE: re-running with unchanged inputs makes no new agent version. So the fake
 * client counts every call, and the skip is asserted as ZERO calls of every kind — a "cheap" call on the
 * skip path would still be a regression. Each skip key is then shown to be live by changing exactly one
 * input (a CONTROL per skip), or a provisioner that never updated anything would pass the skip tests.
 *
 * ⚠️ Nothing here may reach Anthropic or GitHub: the client is a fake (`setManagedClientForTests`), the
 * reference source is a fake (`setReferenceSourceForTests`), and both stores are throwaways under the OS
 * temp dir — the real ones fall back to the developer's `.data/`.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { FsObjectStore } from '~/lib/.server/storage/store';
import { PromptVersionStore, setPromptStore } from '~/lib/.server/prompt/store';
import { SkillVersionStore, setSkillStore } from '~/lib/.server/skills/store';
import { setManagedClientForTests } from './config';
import {
  canonicalJson,
  getManagedAgentRecord,
  isReferenceDocPath,
  provisionManagedAgent,
  setReferenceSourceForTests,
} from './provision';

const system = vi.hoisted(() => ({ suffix: '' }));

vi.mock('./system-prompt', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./system-prompt')>();

  return { ...actual, buildManagedSystemPrompt: () => `${actual.buildManagedSystemPrompt()}${system.suffix}` };
});

interface Calls {
  agentsCreate: unknown[];
  agentsUpdate: Array<[string, Record<string, unknown>]>;
  filesUpload: string[];
  skillsCreate: number;
  skillVersionsCreate: string[];
  environmentsCreate: number;
}

function fakeClient(calls: Calls): Anthropic {
  let agentVersion = 0;
  let n = 0;

  return {
    beta: {
      agents: {
        create: async (params: unknown) => {
          calls.agentsCreate.push(params);
          agentVersion = 1;

          return { id: 'agent_1', version: agentVersion };
        },
        update: async (id: string, params: Record<string, unknown>) => {
          calls.agentsUpdate.push([id, params]);
          agentVersion++;

          return { id, version: agentVersion };
        },
      },
      files: {
        upload: async ({ file }: { file: { name: string } }) => {
          calls.filesUpload.push(file.name);
          return { id: `file_${++n}` };
        },
      },
      skills: {
        create: async () => {
          calls.skillsCreate++;
          return { id: `skill_${++n}`, latest_version_id: `sv_${n}` };
        },
        versions: {
          create: async (skillId: string) => {
            calls.skillVersionsCreate.push(skillId);
            return { id: `sv_${++n}` };
          },
        },
      },
      environments: {
        create: async () => {
          calls.environmentsCreate++;
          return { id: 'env_1' };
        },
      },
    },
  } as unknown as Anthropic;
}

const REF_TREE = ['reference.md', 'references/a.md', 'training/x.md', 'training/img.png', 'README.md', 'src/x.ts'];

let calls = undefined as unknown as Calls;
let promptStore: PromptVersionStore;
let skillStore: SkillVersionStore;
let roots: string[] = [];
const referenceReads: string[] = [];
const ctx = {};

function totalCalls(): number {
  return (
    calls.agentsCreate.length +
    calls.agentsUpdate.length +
    calls.filesUpload.length +
    calls.skillsCreate +
    calls.skillVersionsCreate.length +
    calls.environmentsCreate
  );
}

/** Clears IN PLACE — the fake client closed over this object, so reassigning would blind every count. */
function resetCalls() {
  calls ??= {
    agentsCreate: [],
    agentsUpdate: [],
    filesUpload: [],
    skillsCreate: 0,
    skillVersionsCreate: [],
    environmentsCreate: 0,
  };
  calls.agentsCreate.length = 0;
  calls.agentsUpdate.length = 0;
  calls.filesUpload.length = 0;
  calls.skillVersionsCreate.length = 0;
  calls.skillsCreate = 0;
  calls.environmentsCreate = 0;
  referenceReads.length = 0;
}

async function newVersion(sha: string, content = 'base prompt') {
  const meta = await promptStore.put({
    content: `${content} ${sha}`,
    sourceCommitSha: sha,
    skillsSetHash: 'h',
    onDemand: {},
    declarations: {},
  });
  await promptStore.activate(meta.id);

  return meta.id;
}

async function putSkill(name: string, body: string) {
  const v = await skillStore.put({
    name,
    description: `The ${name} skill: does things`,
    body,
    sourceCommitSha: 'skills-sha',
    resources: { 'references/notes.md': `${name} notes` },
  });
  await skillStore.activate(name, v.id);
}

beforeEach(async () => {
  vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test-not-real');
  vi.stubEnv('LLM_MODEL', 'claude-sonnet-5-5');
  vi.stubEnv('MANAGED_AGENT_EFFORT', 'medium');
  vi.stubEnv('MANAGED_AGENTS_ENVIRONMENT_ID', undefined as unknown as string);
  vi.stubEnv('SKILLS_EXCLUDE', undefined as unknown as string);
  vi.stubEnv('GITHUB_API_KEY', '');
  vi.stubEnv('VITE_GITHUB_ACCESS_TOKEN', '');
  system.suffix = '';

  const promptRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'managed-prompt-'));
  const skillRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'managed-skills-'));
  roots = [promptRoot, skillRoot];
  promptStore = new PromptVersionStore(new FsObjectStore(promptRoot));
  skillStore = new SkillVersionStore(new FsObjectStore(skillRoot));
  setPromptStore(promptStore);
  setSkillStore(skillStore);

  resetCalls();
  setManagedClientForTests(fakeClient(calls));
  setReferenceSourceForTests({
    list: async () => REF_TREE,
    read: async (_sha, rel) => {
      referenceReads.push(rel);
      return new TextEncoder().encode(`# ${rel}`);
    },
  });

  await putSkill('bt-design', 'Design body');

  // Platform-excluded (exclusions.ts default) — must never be uploaded.
  await putSkill('bt-gauntlet', 'Gauntlet body');
});

afterEach(async () => {
  setManagedClientForTests(undefined);
  setReferenceSourceForTests(undefined);
  setPromptStore(undefined);
  setSkillStore(undefined);
  vi.unstubAllEnvs();
  await Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('provisionManagedAgent', () => {
  it('creates the agent, environment, reference uploads and skills on the first run, and records them on the version', async () => {
    const versionId = await newVersion('sha-a');
    const result = await provisionManagedAgent({ context: ctx });

    expect(result).toMatchObject({
      status: 'created',
      key: 'claude-sonnet-5-5:medium',
      promptVersionId: versionId,
      agentId: 'agent_1',
      agentVersion: 1,
      environmentId: 'env_1',
      referenceFiles: 3,
      skills: 1,
    });
    expect(calls.agentsCreate).toHaveLength(1);
    expect(calls.environmentsCreate).toBe(1);

    // Only reference.md + references/** + training/** text — never the png, README or source.
    expect([...referenceReads].sort()).toEqual(['reference.md', 'references/a.md', 'training/x.md']);
    expect(calls.skillsCreate).toBe(1);

    const created = calls.agentsCreate[0] as Record<string, unknown>;
    expect(created.model).toEqual({ id: 'claude-sonnet-5-5', effort: 'medium' });
    expect(created.skills).toEqual([{ type: 'custom', skill_id: 'skill_4', version: 'sv_4' }]);
    expect(JSON.stringify(created)).not.toContain('bt-gauntlet');

    const record = await getManagedAgentRecord(ctx);
    expect(record?.agentId).toBe('agent_1');
    expect(record?.referenceFiles.map((f) => f.rel)).toEqual(['reference.md', 'references/a.md', 'training/x.md']);
    expect((await promptStore.get(versionId))?.managedAgents?.['claude-sonnet-5-5:medium']?.agentVersion).toBe(1);
  });

  it('makes ZERO client calls when re-run with unchanged inputs (T3 acceptance)', async () => {
    await newVersion('sha-a');
    await provisionManagedAgent({ context: ctx });
    resetCalls();

    /*
     * The per-piece reuse (env, files, skills, agentHash) would ALSO make zero client calls, so the
     * hash skip is pinned by what only it avoids: rewriting the record at all.
     */
    const record = vi.spyOn(promptStore, 'recordManagedAgent');
    const again = await provisionManagedAgent({ context: ctx });

    expect(record).not.toHaveBeenCalled();
    expect(again.status).toBe('unchanged');
    expect(again.agentVersion).toBe(1);
    expect(totalCalls()).toBe(0);
    expect(referenceReads).toHaveLength(0);
  });

  it('carries the agent onto a NEW prompt version whose inputs did not change, with zero calls', async () => {
    await newVersion('sha-a', 'first');
    await provisionManagedAgent({ context: ctx });
    resetCalls();

    const second = await newVersion('sha-a', 'second build, same reference commit');
    const result = await provisionManagedAgent({ context: ctx });

    expect(result).toMatchObject({ status: 'unchanged', promptVersionId: second, agentVersion: 1 });
    expect(totalCalls()).toBe(0);
    expect((await promptStore.get(second))?.managedAgents?.['claude-sonnet-5-5:medium']?.agentId).toBe('agent_1');
  });

  it('CONTROL: a changed system prompt updates the agent to a new version, reusing uploads', async () => {
    await newVersion('sha-a');
    await provisionManagedAgent({ context: ctx });
    resetCalls();

    system.suffix = '\nOne more rule.';

    const result = await provisionManagedAgent({ context: ctx });

    expect(result).toMatchObject({ status: 'updated', agentId: 'agent_1', agentVersion: 2 });
    expect(calls.agentsUpdate).toHaveLength(1);
    expect(calls.agentsUpdate[0][0]).toBe('agent_1');
    expect(calls.agentsUpdate[0][1].version).toBe(1);
    expect(String(calls.agentsUpdate[0][1].system)).toContain('One more rule.');
    expect(calls.agentsCreate).toHaveLength(0);
    expect(calls.filesUpload).toHaveLength(0);
    expect(calls.skillsCreate + calls.skillVersionsCreate.length).toBe(0);
  });

  it('CONTROL: a changed skill uploads a new skill version and updates the agent', async () => {
    await newVersion('sha-a');
    await provisionManagedAgent({ context: ctx });
    resetCalls();

    await putSkill('bt-design', 'Design body, revised');

    const result = await provisionManagedAgent({ context: ctx });

    expect(result.status).toBe('updated');
    expect(calls.skillVersionsCreate).toEqual(['skill_4']);
    expect(calls.skillsCreate).toBe(0);
    expect(calls.agentsUpdate).toHaveLength(1);
    expect(calls.filesUpload).toHaveLength(0);
  });

  it('CONTROL: a new reference commit re-uploads the files but leaves the agent version alone', async () => {
    await newVersion('sha-a');
    await provisionManagedAgent({ context: ctx });
    resetCalls();

    await newVersion('sha-b');

    const result = await provisionManagedAgent({ context: ctx });

    expect(result).toMatchObject({ status: 'unchanged', agentVersion: 1, uploadedFiles: 3 });
    expect(calls.filesUpload).toHaveLength(3);
    expect(calls.agentsUpdate).toHaveLength(0);
    expect(calls.agentsCreate).toHaveLength(0);
    expect((await getManagedAgentRecord(ctx))?.referenceSha).toBe('sha-b');
  });

  it('provisions a separate agent per (model, effort) (D10)', async () => {
    await newVersion('sha-a');
    await provisionManagedAgent({ context: ctx });
    resetCalls();

    vi.stubEnv('LLM_MODEL', 'claude-opus-5-5');

    const result = await provisionManagedAgent({ context: ctx });

    expect(result).toMatchObject({ status: 'created', key: 'claude-opus-5-5:medium' });
    expect(calls.agentsCreate).toHaveLength(1);
  });

  it('force pushes a new agent version unconditionally even when nothing changed', async () => {
    await newVersion('sha-a');
    await provisionManagedAgent({ context: ctx });
    resetCalls();

    const result = await provisionManagedAgent({ context: ctx, force: true });

    expect(result.status).toBe('updated');
    expect(calls.agentsUpdate).toHaveLength(1);
    expect(calls.agentsUpdate[0][1]).not.toHaveProperty('version');
    expect(calls.filesUpload).toHaveLength(0);
  });

  it('reuses MANAGED_AGENTS_ENVIRONMENT_ID instead of creating an environment', async () => {
    vi.stubEnv('MANAGED_AGENTS_ENVIRONMENT_ID', 'env_configured');
    await newVersion('sha-a');

    const result = await provisionManagedAgent({ context: ctx });

    expect(result.environmentId).toBe('env_configured');
    expect(calls.environmentsCreate).toBe(0);
  });

  it('refuses with NotConfiguredError and no client call when ANTHROPIC_API_KEY is absent', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', undefined as unknown as string);
    await newVersion('sha-a');

    await expect(provisionManagedAgent({ context: ctx })).rejects.toMatchObject({
      name: 'NotConfiguredError',
      statusCode: 503,
    });
    await expect(getManagedAgentRecord(ctx)).rejects.toMatchObject({ name: 'NotConfiguredError' });
    expect(totalCalls()).toBe(0);
  });

  it('refuses with NotConfiguredError when no prompt version has been built', async () => {
    await expect(provisionManagedAgent({ context: ctx })).rejects.toMatchObject({ name: 'NotConfiguredError' });
    expect(totalCalls()).toBe(0);
  });
});

describe('PromptStore.recordManagedAgent', () => {
  it('annotates a version without touching its identity, and refuses an unknown id', async () => {
    const versionId = await newVersion('sha-a');
    const before = await promptStore.get(versionId);
    await provisionManagedAgent({ context: ctx });

    const after = await promptStore.get(versionId);

    expect(after?.buildHash).toBe(before?.buildHash);
    expect(after?.contentHash).toBe(before?.contentHash);
    expect(after?.sourceCommitSha).toBe('sha-a');
    expect(after?.content).toBe(before?.content);
    expect(before?.managedAgents).toBeUndefined();
    expect(after?.managedAgents?.['claude-sonnet-5-5:medium']?.agentId).toBe('agent_1');

    const record = after!.managedAgents!['claude-sonnet-5-5:medium'];
    await expect(promptStore.recordManagedAgent('pv_missing', record)).rejects.toThrow(/not found/);
  });
});

describe('helpers', () => {
  it('isReferenceDocPath admits only reference docs', () => {
    expect(isReferenceDocPath('reference.md')).toBe(true);
    expect(isReferenceDocPath('references/web-app-builder.md')).toBe(true);
    expect(isReferenceDocPath('training/declarations/babylon.toolkit.d.ts')).toBe(true);
    expect(isReferenceDocPath('training/assets/logo.png')).toBe(false);
    expect(isReferenceDocPath('references/.hidden.md')).toBe(false);
    expect(isReferenceDocPath('README.md')).toBe(false);
    expect(isReferenceDocPath('referencesX/a.md')).toBe(false);
  });

  it('canonicalJson is independent of key order', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: 'z' } })).toBe(
      canonicalJson({ a: { c: 'z', d: [1, { x: 1, y: 2 }] }, b: 1 }),
    );
    expect(canonicalJson({ a: 1 })).not.toBe(canonicalJson({ a: 2 }));
  });
});
