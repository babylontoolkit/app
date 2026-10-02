/**
 * Reconnect and Stop routes (managed-agents-engine T6), driven through the REAL route modules with only
 * the session mocked: `/api/agent/managed/status` and `/api/agent/managed/interrupt`.
 *
 * Two walls on both — a verified session, then project ownership (404-not-403) — and the chat must
 * belong to that project: another project's chat answers exactly like a missing one.
 * ⚠️ Beside the code, never in `app/routes/` (Remix would compile a spec there as a route).
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FsChatIndex, setChatIndex } from '~/lib/.server/projects/chat-index';
import { setProjectStore } from '~/lib/.server/projects/store';
import type { ProjectStore } from '~/lib/.server/projects/types';
import { loader as statusLoader } from '~/routes/api.agent.managed.status';
import { action as interruptAction } from '~/routes/api.agent.managed.interrupt';
import { setManagedClientForTests } from './config';
import { isPendingTurn } from './control';
import { createFakeManagedClient, type FakeClient } from './fake-session.testkit';

const auth = vi.hoisted(() => ({ signedIn: true }));

vi.mock('~/lib/.server/supabase/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/lib/.server/supabase/auth')>();

  return {
    ...actual,
    requireVerifiedUser: async () => {
      if (!auth.signedIn) {
        throw new actual.UnauthorizedError('Sign in to continue.');
      }

      return { id: 'user-a', email: 'a@example.com', emailVerified: true, isAdmin: false };
    },
  };
});

const MINE = 'prj_mine';
const THEIRS = 'prj_theirs';

let tmp: string;
let index: FsChatIndex;
let fake: FakeClient;

beforeEach(async () => {
  auth.signedIn = true;
  vi.stubEnv('ANTHROPIC_API_KEY', 'test-key-not-real');
  vi.stubEnv('AGENT_ENGINE', 'managed');

  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'managed-control-'));
  index = new FsChatIndex(tmp);
  setChatIndex(index);
  setProjectStore({
    get: async (id: string) =>
      id === MINE ? { id: MINE, userId: 'user-a' } : id === THEIRS ? { id: THEIRS, userId: 'user-b' } : null,
  } as unknown as ProjectStore);

  fake = createFakeManagedClient();
  setManagedClientForTests(fake.client);
});

afterEach(async () => {
  setManagedClientForTests(undefined);
  setChatIndex(undefined);
  setProjectStore(undefined);
  vi.unstubAllEnvs();
  await fs.rm(tmp, { recursive: true, force: true });
});

async function chatWithSession(projectId: string, sessionId: string) {
  const chatId = randomUUID();
  await index.claimManagedSession({ id: chatId, projectId, sessionId, now: new Date().toISOString() });

  return chatId;
}

const status = (projectId: string, chatId: string) =>
  statusLoader({
    request: new Request(`http://localhost/api/agent/managed/status?projectId=${projectId}&chatId=${chatId}`),
    context: {},
    params: {},
  } as never);

const interrupt = (body: unknown) =>
  interruptAction({
    request: new Request('http://localhost/api/agent/managed/interrupt', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    }),
    context: {},
    params: {},
  } as never);

describe('isPendingTurn', () => {
  it('running is pending; idle is pending only while WAITING on an unanswered custom call', () => {
    const call = { type: 'agent.custom_tool_use', id: 'c1', name: 'x', input: {} };
    const waiting = { type: 'session.status_idle', id: 'i1', stop_reason: { type: 'requires_action' } };

    expect(isPendingTurn('running', [])).toBe(true);
    expect(isPendingTurn('idle', [call, waiting])).toBe(true);
    expect(
      isPendingTurn('idle', [call, waiting, { type: 'user.custom_tool_result', id: 'r1', custom_tool_use_id: 'c1' }]),
    ).toBe(false);

    /* An INTERRUPTED turn: the API answered the call itself and idled at end_turn — not pending. */
    expect(
      isPendingTurn('idle', [
        call,
        waiting,
        { type: 'user.interrupt', id: 'u1' },
        { type: 'agent.tool_result', id: 't1', tool_use_id: 'c1' },
        { type: 'session.status_idle', id: 'i2', stop_reason: { type: 'end_turn' } },
      ]),
    ).toBe(false);
    expect(isPendingTurn('terminated', [])).toBe(false);
  });
});

describe('GET /api/agent/managed/status', () => {
  it('pending when the session is waiting on an unanswered tool call', async () => {
    fake.seed('sesn_w', [
      {
        type: 'user.message',
        content: [
          {
            type: 'text',
            text: '[Project files — paths only; read them with project_read]\nsrc/a.ts\n[End of project files]\n\nmake it drift',
          },
        ],
      },
      { type: 'agent.custom_tool_use', name: 'project_write', input: {} },
      { type: 'session.status_idle', stop_reason: { type: 'requires_action' } },
    ]);

    const response = await status(MINE, await chatWithSession(MINE, 'sesn_w'));

    expect(response.status).toBe(200);

    /* The turn's own words come back (manifest removed), so a reopened tab can show what it resumes. */
    expect(await response.json()).toEqual({ engine: 'managed', pending: true, userText: 'make it drift' });
  });

  it('not pending once the turn ended (CONTROL), nor for a chat with no session, nor on the legacy engine', async () => {
    fake.seed('sesn_done', [
      { type: 'user.message', content: [] },
      { type: 'agent.message', content: [] },
      { type: 'session.status_idle', stop_reason: { type: 'end_turn' } },
    ]);

    expect(await (await status(MINE, await chatWithSession(MINE, 'sesn_done'))).json()).toEqual({
      engine: 'managed',
      pending: false,
    });
    expect(await (await status(MINE, randomUUID())).json()).toEqual({ engine: 'managed', pending: false });

    vi.stubEnv('AGENT_ENGINE', 'legacy');
    fake.seed('sesn_l', [{ type: 'agent.custom_tool_use', name: 'x', input: {} }]);
    expect(await (await status(MINE, await chatWithSession(MINE, 'sesn_l'))).json()).toEqual({
      engine: 'legacy',
      pending: false,
    });
  });

  it('walls: signed out → 401; another user’s project → 404; my project + another project’s chat → 404', async () => {
    fake.seed('sesn_t', []);

    const theirChat = await chatWithSession(THEIRS, 'sesn_t');

    auth.signedIn = false;
    expect((await status(MINE, theirChat)).status).toBe(401);

    auth.signedIn = true;
    expect((await status(THEIRS, theirChat)).status).toBe(404);

    const response = await status(MINE, theirChat);

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ message: 'Chat not found.' });
  });
});

describe('POST /api/agent/managed/interrupt', () => {
  it('sends user.interrupt to the chat’s session', async () => {
    fake.seed('sesn_i', []);

    const chatId = await chatWithSession(MINE, 'sesn_i');
    const response = await interrupt({ projectId: MINE, chatId });

    expect(await response.json()).toEqual({ interrupted: true });
    expect(fake.sends).toEqual([{ sessionId: 'sesn_i', events: [{ type: 'user.interrupt' }] }]);
  });

  it('another project’s chat → 404 and NOTHING is sent; a chat with no session interrupts nothing', async () => {
    fake.seed('sesn_x', []);

    const theirChat = await chatWithSession(THEIRS, 'sesn_x');

    expect((await interrupt({ projectId: MINE, chatId: theirChat })).status).toBe(404);
    expect((await interrupt({ projectId: THEIRS, chatId: theirChat })).status).toBe(404);
    expect(await (await interrupt({ projectId: MINE, chatId: randomUUID() })).json()).toEqual({ interrupted: false });
    expect(fake.sends).toEqual([]);
  });
});
