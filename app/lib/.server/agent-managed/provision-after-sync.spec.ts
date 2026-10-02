/**
 * A Synchronize provisions the managed agent (`provision-after-sync.ts`, managed-agents-engine plan T12).
 *
 * Driven through the REAL `/api/admin/prompt` action — only the GitHub-reading halves (skills sync, prompt
 * build), the cache warmer and the provisioner are replaced. The property that matters most is the one
 * that fails silently: a provisioning failure must NOT turn a sync that already activated into a 500 (the
 * admin would retry a sync that worked), yet it must be reported, or the panel says "Live now" while
 * managed turns keep reading the previous docs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setSyncProvisionerForTests } from './provision-after-sync';
import { type PromptStore, setPromptStore } from '~/lib/.server/prompt/store';
import { action } from '~/routes/api.admin.prompt';

const mocks = vi.hoisted(() => ({
  alert: vi.fn(),
  syncSkills: vi.fn(),
  buildSystemPrompt: vi.fn(),
}));

vi.mock('~/lib/.server/supabase/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  requireAdmin: async () => ({ id: 'admin-1', email: 'a@example.com', emailVerified: true, isAdmin: true }),
}));

vi.mock('~/lib/.server/agent/config', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getPlatformConfig: () => ({ githubToken: undefined, adminToken: undefined }),
}));

vi.mock('~/lib/.server/skills/sync', () => ({ syncSkills: mocks.syncSkills }));
vi.mock('~/lib/.server/prompt/build', () => ({ buildSystemPrompt: mocks.buildSystemPrompt }));
vi.mock('~/lib/.server/prompt/cache-warmer', () => ({ warmAfterPromptChange: () => undefined }));
vi.mock('~/lib/.server/prompt/active', () => ({ invalidateActivePrompt: () => undefined }));

vi.mock('~/lib/.server/monitoring', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getMonitor: () => ({ alert: mocks.alert, captureException: vi.fn(), captureMessage: vi.fn(), track: vi.fn() }),
}));

const provisioner = vi.fn();

const refresh = async () => {
  const response = await (action as unknown as (args: unknown) => Promise<Response>)({
    request: new Request('http://localhost/api/admin/prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'refresh' }),
    }),
    context: {},
    params: {},
  });

  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
};

beforeEach(() => {
  // `env()` falls back to process.env (vitest loads `.env.local`): every case states the two vars it means.
  vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test-not-real');
  vi.stubEnv('AGENT_ENGINE', undefined as unknown as string);

  mocks.alert.mockReset();
  mocks.syncSkills.mockReset().mockResolvedValue({
    skillsIndex: '',
    sourceCommitSha: 'skills-sha',
    synced: 0,
    skipped: 0,
  });
  mocks.buildSystemPrompt.mockReset().mockResolvedValue({
    status: 'created',
    version: { id: 'pv_new', lastSeenCommitSha: 'agent-sha' },
    fetched: 1,
    sourceCommitSha: 'agent-sha',
  });

  provisioner.mockReset().mockResolvedValue({
    status: 'updated',
    key: 'claude-sonnet-5-5:medium',
    promptVersionId: 'pv_new',
    agentId: 'agent_1',
    agentVersion: 4,
    environmentId: 'env_1',
    referenceFiles: 10,
    skills: 3,
    uploadedFiles: 10,
    uploadedSkills: 0,
  });
  setSyncProvisionerForTests(provisioner);

  /* The failure path reads the active version back — never the developer's real prompt store. */
  setPromptStore({ getActive: async () => null, list: async () => [] } as unknown as PromptStore);
});

afterEach(() => {
  vi.unstubAllEnvs();
  setSyncProvisionerForTests(undefined);
  setPromptStore(undefined);
});

describe('Synchronize provisions the managed agent (T12)', () => {
  it('a successful sync provisions and reports the agent', async () => {
    const { status, body } = await refresh();

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(provisioner).toHaveBeenCalledTimes(1);
    expect(body.managedAgent).toEqual({
      status: 'updated',
      agentId: 'agent_1',
      agentVersion: 4,
      promptVersionId: 'pv_new',
    });
  });

  it('provisioning runs AFTER the build activated (never against the previous version)', async () => {
    const order: string[] = [];
    mocks.buildSystemPrompt.mockImplementation(async () => {
      order.push('build');
      return { status: 'created', version: { id: 'pv_new', lastSeenCommitSha: 's' }, fetched: 1, sourceCommitSha: 's' };
    });
    provisioner.mockImplementation(async () => {
      order.push('provision');
      throw new Error('stop here');
    });

    await refresh();

    expect(order).toEqual(['build', 'provision']);
  });

  it('a provisioning failure does NOT fail the sync — it is reported and alerted', async () => {
    provisioner.mockRejectedValue(new Error('Anthropic is down'));

    const { status, body } = await refresh();

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.status).toBe('created');
    expect(body.managedAgent).toEqual({ error: 'Anthropic is down' });
    expect(mocks.alert).toHaveBeenCalledTimes(1);
    expect(mocks.alert.mock.calls[0][1]).toContain('Anthropic is down');
    expect(mocks.alert.mock.calls[0][2]).toMatchObject({ scope: 'managed-provision' });
  });

  it('no Anthropic key → not called, reported as not configured', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', undefined as unknown as string);

    const { status, body } = await refresh();

    expect(status).toBe(200);
    expect(provisioner).not.toHaveBeenCalled();
    expect(body.managedAgent).toEqual({ skipped: 'not-configured' });
    expect(mocks.alert).not.toHaveBeenCalled();
  });

  it('a legacy deploy (the kill switch) mints no agent', async () => {
    vi.stubEnv('AGENT_ENGINE', 'legacy');

    const { body } = await refresh();

    expect(provisioner).not.toHaveBeenCalled();
    expect(body.managedAgent).toEqual({ skipped: 'legacy-engine' });
  });

  it('CONTROL: a FAILED sync never provisions (the previous version stays, nothing new to provision)', async () => {
    mocks.buildSystemPrompt.mockRejectedValue(new Error('docs build broke'));

    const { status } = await refresh().catch(() => ({ status: 500 }));

    expect(status).toBe(500);
    expect(provisioner).not.toHaveBeenCalled();
  });
});
