/**
 * Deleting an account deletes the account (SPEC §4.5.1).
 *
 * Two halves, because this path fails in two unrelated ways:
 *
 * 1. **The decision** — pure and exhaustive. It is the only thing standing between a stray click and
 *    an irreversible purge, so it is tested the way `auto-repair` and `restore-target` are: every
 *    input, including the ones a caller "could not" send.
 * 2. **The execution** — a property, not a call list. After a deletion, storage holds nothing
 *    belonging to that user. Asserting "we called `deleteMessages`" would pass forever the day a new
 *    kind of byte is added and nobody reaps it, which is exactly how the orphaned `messages/` payload
 *    that `delete-leaves-nothing.spec.ts` exists for got in.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FsObjectStore } from '~/lib/.server/storage/store';
import { setObjectStore } from '~/lib/.server/storage';
import { FsChatIndex, setChatIndex } from '~/lib/.server/projects/chat-index';
import { FsProjectStore, setProjectStore } from '~/lib/.server/projects/store';
import { listChats, putChat } from '~/lib/.server/projects/message-store';
import { putRemixSeed, seedKey } from '~/lib/.server/share/seed-store';
import { putWorkingCopy, workingCopyKey } from '~/lib/.server/projects/working-copy';
import { buildObjectKey, buildPrefix } from '~/lib/.server/share/publish';
import { FsGitTokenStore, setGitTokenStore } from '~/lib/.server/git/token-store';
import { decideAccountDeletion, deleteAccount } from './delete-account';
import type { AuthUser } from '~/lib/.server/supabase/auth';

const USER: AuthUser = {
  id: 'user-1',
  email: 'Builder@Example.com',
  emailVerified: true,
  displayName: 'Builder',
  isAdmin: false,
  isLocal: false,
};

/** As in `delete-leaves-nothing.spec.ts`: unmocked, this drags the CodeSandbox SDK into the test. */
vi.mock('~/lib/.server/sandbox/service', () => ({
  deleteSandbox: vi.fn(async () => undefined),
}));

describe('decideAccountDeletion — the wall in front of an irreversible purge', () => {
  const base = { email: 'builder@example.com', accountsEnabled: true };

  it('accepts the exact email', () => {
    expect(decideAccountDeletion({ ...base, confirmation: 'builder@example.com' })).toEqual({ ok: true });
  });

  /*
   * An address pasted from a password manager arrives with a trailing space or a capital letter. It is
   * not a different person, and refusing it teaches the user to retype rather than to reconsider.
   */
  it('accepts it case-insensitively and ignores surrounding whitespace', () => {
    expect(decideAccountDeletion({ ...base, confirmation: '  BUILDER@Example.com  ' })).toEqual({ ok: true });
  });

  it('refuses a different address', () => {
    const decision = decideAccountDeletion({ ...base, confirmation: 'someone@else.com' });

    expect(decision.ok).toBe(false);
    expect(decision).toMatchObject({ status: 400 });
  });

  /*
   * The dangerous near-miss: an empty confirmation against an empty session email would compare equal
   * under a naive `typed === actual`, and delete an account nobody named.
   */
  it('refuses when we cannot tell which account this is, even against an empty confirmation', () => {
    expect(decideAccountDeletion({ email: '', accountsEnabled: true, confirmation: '' }).ok).toBe(false);
    expect(decideAccountDeletion({ email: '', accountsEnabled: true, confirmation: '   ' }).ok).toBe(false);
  });

  it.each([undefined, null, '', '   ', 42, {}, [], true])('refuses the non-answer %p', (confirmation) => {
    expect(decideAccountDeletion({ ...base, confirmation }).ok).toBe(false);
  });

  /*
   * Local mode has no accounts (§4.5) — there is nothing to delete, and the alternative reading
   * ("delete the local developer") would wipe the operator's own workspace on a typed email.
   */
  it('refuses in local mode, whatever was typed', () => {
    const decision = decideAccountDeletion({
      email: 'local@localhost',
      accountsEnabled: false,
      confirmation: 'local@localhost',
    });

    expect(decision.ok).toBe(false);
    expect(decision).toMatchObject({ status: 503 });
  });

  it('never throws, for any input', () => {
    const inputs: unknown[] = [undefined, null, 0, '', 'x', {}, [], Symbol('s')];

    for (const confirmation of inputs) {
      for (const email of ['builder@example.com', '', undefined as unknown as string]) {
        for (const accountsEnabled of [true, false]) {
          expect(() => decideAccountDeletion({ confirmation, email, accountsEnabled })).not.toThrow();
        }
      }
    }
  });
});

describe('deleteAccount — the property: nothing of theirs is left', () => {
  let tmp: string;
  let objects: FsObjectStore;
  let projects: FsProjectStore;
  let tokens: FsGitTokenStore;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'account-delete-'));
    objects = new FsObjectStore(path.join(tmp, 'objects'));
    projects = new FsProjectStore(path.join(tmp, 'projects'));
    tokens = new FsGitTokenStore(path.join(tmp, 'tokens'));

    // All four, or this writes into the developer's real `.data/` — see `message-store.spec.ts`.
    setObjectStore(objects);
    setChatIndex(new FsChatIndex(path.join(tmp, 'index')));
    setProjectStore(projects);
    setGitTokenStore(tokens);
  });

  afterEach(async () => {
    setObjectStore(undefined);
    setChatIndex(undefined);
    setProjectStore(undefined);
    setGitTokenStore(null);
    await fs.rm(tmp, { recursive: true, force: true });
  });

  /** A project with one of every kind of byte the platform holds for it. */
  const givenAFullProject = async (name: string, userId = USER.id) => {
    const project = await projects.create({ userId, name, templateId: 'racing' });

    await putChat(project.id, {
      serverChatId: crypto.randomUUID(),
      title: 'Chat',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      messages: [{ role: 'user', content: 'hi' }],
    });
    await putRemixSeed(project.id, { 'a.ts': { type: 'file', content: 'x', isBinary: false } });
    await putWorkingCopy(project.id, {
      projectId: project.id,
      seq: 1,
      updatedAt: 'now',
      files: { 'a.ts': { type: 'file', content: 'x', isBinary: false } },
    });

    return project;
  };

  /*
   * A user with ONE project cannot tell "reaps every project" from "reaps the first". The account-scale
   * version of the many-chats argument in `delete-leaves-nothing.spec.ts`.
   */
  it('reaps every project, not merely the first', async () => {
    const a = await givenAFullProject('A');
    const b = await givenAFullProject('B');
    const c = await givenAFullProject('C');

    const result = await deleteAccount(USER, {});

    expect(result.projectsDeleted).toBe(3);
    expect(await projects.listByUser(USER.id)).toEqual([]);

    for (const project of [a, b, c]) {
      expect(await listChats(project.id)).toEqual([]);
      expect(await objects.get(seedKey(project.id))).toBeNull();
      expect(await objects.get(workingCopyKey(project.id))).toBeNull();
    }
  });

  /*
   * 🔴 The published build. `unpublish` was reachable only from the Share dialog, so a delete removed
   * the row that resolves `/play/:shareId` and left the built game — every asset — in object storage
   * under a share-id prefix that no surviving record mentions. Unreachable and undeleted, i.e. the
   * `messages/` orphan one door along.
   */
  it('deletes the published build, so a game a stranger could play stops existing', async () => {
    const project = await givenAFullProject('Published');
    const shareId = 'share-abc';

    await projects.update(project.id, { shareId, sharedAt: new Date().toISOString() });

    // Through `buildObjectKey`, so the fixture lands where a real publish puts it.
    await objects.put(buildObjectKey(shareId, 'index.html'), new TextEncoder().encode('<html></html>'));
    await objects.put(buildObjectKey(shareId, 'assets/game.js'), new TextEncoder().encode('game'));

    expect(await objects.list(buildPrefix(shareId))).toHaveLength(2);

    await deleteAccount(USER, {});

    expect(await objects.list(buildPrefix(shareId))).toEqual([]);
  });

  /*
   * The credential is the one item here whose survival is a security problem rather than an untidiness
   * one: an encrypted OAuth token for somebody's GitHub, held by a platform they have just left.
   */
  it('deletes every git credential, on every provider', async () => {
    await tokens.put({
      userId: USER.id,
      provider: 'github',
      accessToken: 'gh-token',
      providerLogin: 'octocat',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    await tokens.put({
      userId: USER.id,
      provider: 'gitlab',
      accessToken: 'gl-token',
      providerLogin: 'octocat',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });

    await deleteAccount(USER, {});

    expect(await tokens.listByUser(USER.id)).toEqual([]);
    expect(await tokens.get(USER.id, 'github')).toBeNull();
    expect(await tokens.get(USER.id, 'gitlab')).toBeNull();
  });

  /*
   * 🔴 CONTROL, and the most important test in this file: a reaper that works by user id is one typo
   * away from working by no id at all. Deleting one account must not touch another's projects, bytes,
   * or credentials — and nothing in the assertions above would notice if it did.
   */
  it('CONTROL — touches nothing belonging to anybody else', async () => {
    await givenAFullProject('Mine');

    const theirs = await givenAFullProject('Theirs', 'someone-else');
    await tokens.put({
      userId: 'someone-else',
      provider: 'github',
      accessToken: 'their-token',
      providerLogin: 'them',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });

    await deleteAccount(USER, {});

    expect(await projects.listByUser('someone-else')).toHaveLength(1);
    expect(await listChats(theirs.id)).toHaveLength(1);
    expect(await objects.get(seedKey(theirs.id))).not.toBeNull();
    expect(await objects.get(workingCopyKey(theirs.id))).not.toBeNull();
    expect(await tokens.get('someone-else', 'github')).not.toBeNull();
  });

  it('is idempotent — a retry after a partial failure completes rather than throwing', async () => {
    await givenAFullProject('A');

    await deleteAccount(USER, {});

    await expect(deleteAccount(USER, {})).resolves.toEqual({ projectsDeleted: 0 });
  });

  it('handles an account with nothing in it', async () => {
    await expect(deleteAccount(USER, {})).resolves.toEqual({ projectsDeleted: 0 });
  });
});
