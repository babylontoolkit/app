/**
 * Secrets must not reach the server working copy (SPEC §4.5.4c, §5).
 *
 * The working copy lives on OUR infrastructure, which makes this a bigger exposure than the push it is
 * modelled on: a push at least goes to a repo the user owns. `saveWorkingCopy` therefore filters
 * through the SAME `isSecretPath` rule as the push and the remix seed — one rule, one place — and this
 * pins that it actually happens on the wire, not merely that the rule exists.
 *
 * The narrower rule this family replaced (`/\.env\.[^/]*local$/`) shipped `.env.production`, the most
 * dangerous file of the set, so the assertions below name the whole family explicitly.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { saveWorkingCopy } from './projects';
import { repoStatus } from './repo-status';
import type { SerializedFileMap } from '~/lib/binary/binary-files';

const text = (content: string) => ({ type: 'file' as const, content, isBinary: false });

let sent: SerializedFileMap;
let body: { files: SerializedFileMap; branch?: string; seq?: number; messageId?: string };

beforeEach(() => {
  sent = {};
  body = { files: {} };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      sent = body.files;

      return new Response(JSON.stringify({ ok: true, seq: 1 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('saveWorkingCopy', () => {
  it('never uploads the .env family', async () => {
    await saveWorkingCopy('prj_1', 1, {
      'src/main.ts': text('console.log(1)'),
      '.env': text('KIE_API_KEY=secret'),
      '.env.local': text('LOCAL=1'),
      '.env.production': text('PROD=1'),
      '.npmrc': text('//registry:_authToken=nope'),
    });

    expect(Object.keys(sent)).toEqual(['src/main.ts']);
    expect(JSON.stringify(sent)).not.toContain('secret');
    expect(JSON.stringify(sent)).not.toContain('_authToken');
  });

  it('uploads everything that is not a secret, untouched', async () => {
    const files: SerializedFileMap = {
      'src/main.ts': text('console.log(1)'),
      'public/hero.jpg': { type: 'file', content: 'AAAA', isBinary: true, size: 3 },
      'package.json': text('{}'),
    };

    await saveWorkingCopy('prj_1', 4, files);

    expect(sent).toEqual(files);
  });

  /* A project that is nothing BUT secrets must not silently become an empty upload the route rejects. */
  it('sends the seq it was given', async () => {
    await saveWorkingCopy('prj_1', 42, { 'a.ts': text('x') });

    const body = JSON.parse(
      String((globalThis.fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0][1].body),
    );
    expect(body.seq).toBe(42);
  });
});

/**
 * 🔴 THE BRANCH STAMP, ON THE WIRE (§4.13a T17).
 *
 * `saveWorkingCopy` is the per-generation checkpoint's writer — the most frequent working-copy write
 * in the product — and it is the one that made the stamp rule necessary. While it could not reach
 * `repoStatus` (an import cycle) it wrote every copy unstamped, and because a PUT replaces the whole
 * object it also ACTIVELY UN-STAMPED: `applyBranchTree` would stamp `feature/hud`, and the next
 * generation would overwrite the copy with nothing. The guard had a lifetime of one turn.
 *
 * ⚠️ Asserted BEHAVIOURALLY here, on the bytes that actually leave the browser, because the sibling
 * source scan cannot see the difference between "the expression is present" and "the expression is in
 * the body that is sent". This is *the* writer whose absence was the found defect, so it gets the
 * stronger instrument.
 */
describe('saveWorkingCopy stamps the branch it is currently on', () => {
  it('sends the branch from the shared store', async () => {
    repoStatus.set({ linked: true, branch: 'feature/boost-pads' } as never);

    await saveWorkingCopy('prj_1', 1, { 'src/main.ts': text('x') });

    expect(body.branch).toBe('feature/boost-pads');
  });

  /**
   * ⚠️ ABSENT, not empty and not a guess. An unstamped copy reads as UNKNOWN to `workingCopyRanks`
   * and behaves exactly as copies did before the field existed; a copy stamped with a WRONG branch
   * would be refused, silently turning crash recovery off for a copy that is in fact fine. So the
   * unknown case must produce no key at all — the `remoteHead` `undefined`-vs-`null` distinction.
   */
  it('sends no branch at all when the project has no link', async () => {
    repoStatus.set(undefined);

    await saveWorkingCopy('prj_1', 1, { 'src/main.ts': text('x') });

    expect(body.branch).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('"branch"');
  });

  /* CONTROL: the assertions above are about the BRANCH, not about the request failing to be made. */
  it('CONTROL — the files still travel either way', async () => {
    repoStatus.set(undefined);

    await saveWorkingCopy('prj_1', 1, { 'src/main.ts': text('x') });

    expect(sent['src/main.ts']).toEqual(text('x'));
  });
});
