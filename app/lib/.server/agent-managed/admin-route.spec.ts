/**
 * `/api/admin/managed-agent` (`_specs/managed-agents-engine_plan.md` T3): admin-only, and "not configured"
 * is a describable state — 503 with the sentence on the action, a 200 `configured:false` on the loader so
 * the rest of the Admin panel still loads. Driven through the real route module with only the session
 * mocked. ⚠️ Beside the code, never in `app/routes/` (Remix would compile a spec there as a route).
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { FsObjectStore } from '~/lib/.server/storage/store';
import { PromptVersionStore, setPromptStore } from '~/lib/.server/prompt/store';
import { SkillVersionStore, setSkillStore } from '~/lib/.server/skills/store';
import { loader, action } from '~/routes/api.admin.managed-agent';
import { setManagedClientForTests } from './config';

const auth = vi.hoisted(() => ({ admin: true }));

vi.mock('~/lib/.server/supabase/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/lib/.server/supabase/auth')>();

  return {
    ...actual,
    requireAdmin: async () => {
      if (!auth.admin) {
        throw new actual.ForbiddenError('Admin access required.');
      }

      return { id: 'admin-1', email: 'a@example.com', emailVerified: true, isAdmin: true };
    },
  };
});

const clientCalls: string[] = [];
let roots: string[] = [];

const args = (method: 'GET' | 'POST', body?: unknown) =>
  ({
    request: new Request('http://localhost/api/admin/managed-agent', {
      method,
      ...(body ? { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } } : {}),
    }),
    context: {},
    params: {},
  }) as never;

beforeEach(async () => {
  auth.admin = true;
  clientCalls.length = 0;
  vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test-not-real');
  vi.stubEnv('LLM_MODEL', 'claude-sonnet-5-5');
  vi.stubEnv('MANAGED_AGENT_EFFORT', 'medium');

  const promptRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'managed-route-prompt-'));
  const skillRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'managed-route-skills-'));
  roots = [promptRoot, skillRoot];
  setPromptStore(new PromptVersionStore(new FsObjectStore(promptRoot)));
  setSkillStore(new SkillVersionStore(new FsObjectStore(skillRoot)));

  // Any touch of the client is recorded — none of these cases may reach Anthropic.
  setManagedClientForTests(
    new Proxy({} as Anthropic, {
      get: (_t, prop) => {
        clientCalls.push(String(prop));
        throw new Error('client must not be used');
      },
    }),
  );
});

afterEach(async () => {
  setManagedClientForTests(undefined);
  setPromptStore(undefined);
  setSkillStore(undefined);
  vi.unstubAllEnvs();
  await Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('/api/admin/managed-agent', () => {
  it('refuses a non-admin on both GET and POST', async () => {
    auth.admin = false;

    expect((await loader(args('GET'))).status).toBe(403);
    expect((await action(args('POST', { action: 'provision' }))).status).toBe(403);
    expect(clientCalls).toEqual([]);
  });

  it('CONTROL: an admin GET succeeds', async () => {
    const response = await loader(args('GET'));
    const body = (await response.json()) as { configured: boolean; agent: unknown; key: string };

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ configured: true, agent: null, key: 'claude-sonnet-5-5:medium' });
  });

  it('answers 503 with the sentence when ANTHROPIC_API_KEY is absent, and the loader reports not configured', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', undefined as unknown as string);

    const post = await action(args('POST', { action: 'provision' }));
    const postBody = (await post.json()) as { message: string };

    expect(post.status).toBe(503);
    expect(postBody.message).toContain('ANTHROPIC_API_KEY');

    const get = await loader(args('GET'));
    const getBody = (await get.json()) as { configured: boolean; message: string };

    expect(get.status).toBe(200);
    expect(getBody.configured).toBe(false);
    expect(getBody.message).toContain('ANTHROPIC_API_KEY');
    expect(clientCalls).toEqual([]);
  });

  it('answers 503 when no prompt version exists yet', async () => {
    const post = await action(args('POST', { action: 'provision' }));

    expect(post.status).toBe(503);
    expect(((await post.json()) as { message: string }).message).toContain('Synchronize');
    expect(clientCalls).toEqual([]);
  });

  it('rejects an unknown action with 400', async () => {
    expect((await action(args('POST', { action: 'nope' }))).status).toBe(400);
  });
});
