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
import type { SerializedFileMap } from '~/lib/binary/binary-files';

const text = (content: string) => ({ type: 'file' as const, content, isBinary: false });

let sent: SerializedFileMap;

beforeEach(() => {
  sent = {};
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      sent = (JSON.parse(String(init.body)) as { files: SerializedFileMap }).files;
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
