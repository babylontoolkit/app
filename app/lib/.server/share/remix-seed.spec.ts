/**
 * The remix seed (SPEC §4.8, §4.5.4b).
 *
 * Two failures to keep out, and they pull in opposite directions — which is the whole reason this is a
 * tested pure function rather than a filter inlined into the route:
 *
 *   - too little → remix produces an empty project (the regression this module was written to fix);
 *   - too much   → the publisher's API keys are handed to every stranger who clicks Remix.
 */
import { describe, expect, it } from 'vitest';
import { buildRemixSeed } from './remix-seed';
import type { SerializedFileMap } from '~/lib/binary/binary-files';

const file = (content: string) => ({ type: 'file' as const, content, isBinary: false });

const binary = (base64: string, size: number) => ({
  type: 'file' as const,
  content: base64,
  isBinary: true,
  size,
});

describe('what the seed carries', () => {
  it('carries the project’s source', () => {
    const { files } = buildRemixSeed({
      'src/scripts/RacerMode.ts': file('export class RacerMode {}'),
      'package.json': file('{}'),
      'vite.config.ts': file('export default {}'),
    });

    expect(Object.keys(files).sort()).toEqual(['package.json', 'src/scripts/RacerMode.ts', 'vite.config.ts']);
  });

  /**
   * A remix of a racing game with no car model is not a remix. Binary bytes ride as base64 on the wire
   * and must arrive untouched (`spec/binary-files.md`) — this is the same map on both sides, so the
   * dirent must come through identical, `size` and all.
   */
  it('carries binaries through byte-for-byte, with their true size', () => {
    const car = binary('R0lGODlhAQABAAAAACw=', 4096);
    const { files } = buildRemixSeed({ 'public/models/car.glb': car });

    expect(files['public/models/car.glb']).toEqual(car);
    expect(files['public/models/car.glb']).toBe(car);
  });

  it('keeps folders, so an empty directory in the tree survives the clone', () => {
    const { files } = buildRemixSeed({ 'src/assets': { type: 'folder' } });

    expect(files['src/assets']).toEqual({ type: 'folder' });
  });
});

describe('what the seed must never carry', () => {
  /**
   * 🔴 The one that matters. A seed is handed to STRANGERS — this is sharper than the push path, where
   * `.env` merely reaches a repo the user owns.
   */
  it('withholds the .env family and says which files it withheld', () => {
    const { files, excludedSecrets } = buildRemixSeed({
      '.env': file('ANTHROPIC_API_KEY=sk-ant-real'),
      '.env.local': file('SUPABASE_KEY=secret'),
      '.env.production': file('STRIPE_SECRET=sk_live_real'),
      'src/main.ts': file('console.log(1)'),
    });

    expect(Object.keys(files)).toEqual(['src/main.ts']);
    expect(excludedSecrets.sort()).toEqual(['.env', '.env.local', '.env.production']);
  });

  /**
   * `.env.production` does not end in `local`. A narrower rule that mirrored the gitignore convention
   * pushed it once already (`git/sync-logic.ts`) — which is exactly why this module shares that rule
   * rather than writing a second copy of "what counts as a secret".
   */
  it('withholds .env.production specifically', () => {
    expect(buildRemixSeed({ '.env.production': file('x') }).excludedSecrets).toEqual(['.env.production']);
  });

  it('carries .env.example — it is documentation, and a remix without it is worse off', () => {
    const { files, excludedSecrets } = buildRemixSeed({ '.env.example': file('API_KEY=your-key-here') });

    expect(files['.env.example']).toBeDefined();
    expect(excludedSecrets).toEqual([]);
  });

  it('drops node_modules, dist and .git rather than cloning megabytes of them', () => {
    const { files } = buildRemixSeed({
      'node_modules/babylonjs/index.js': file('/* huge */'),
      'src/nested/node_modules/x/y.js': file('x'),
      'dist/assets/index-abc.js': file('bundled'),
      'src/dist/thing.ts': file('nested dist'),
      '.git/objects/ab/cdef': file('gitobj'),
      'src/main.ts': file('console.log(1)'),
    });

    expect(Object.keys(files)).toEqual(['src/main.ts']);
  });

  /** Dropped bulk is not a secret, and reporting it as one would cry wolf on the line that matters. */
  it('does not report ordinary excluded bulk as a withheld secret', () => {
    expect(buildRemixSeed({ 'node_modules/x/y.js': file('x') }).excludedSecrets).toEqual([]);
  });

  it('is not fooled by a leading slash', () => {
    const { files, excludedSecrets } = buildRemixSeed({
      '/node_modules/x/y.js': file('x'),
      '/src/main.ts': file('ok'),
    });

    expect(Object.keys(files)).toEqual(['/src/main.ts']);
    expect(excludedSecrets).toEqual([]);
  });

  /** `.environment.md` starts with ".env" and is an ordinary file. The rule keys off `.env.`, with the dot. */
  it('does not mistake an ordinary file for a secret because it starts with .env', () => {
    const { files } = buildRemixSeed({ '.environment.md': file('notes') });

    expect(files['.environment.md']).toBeDefined();
  });
});

describe('edge cases', () => {
  it('handles an empty project without throwing', () => {
    expect(buildRemixSeed({})).toEqual({ files: {}, excludedSecrets: [] });
  });

  it('does not mutate the source map', () => {
    const source: SerializedFileMap = { '.env': file('secret'), 'a.ts': file('x') };
    buildRemixSeed(source);

    expect(Object.keys(source).sort()).toEqual(['.env', 'a.ts']);
  });

  /** A project that is nothing BUT secrets seeds empty rather than seeding the secrets. */
  it('returns an empty seed rather than a leaky one', () => {
    const { files, excludedSecrets } = buildRemixSeed({ '.env': file('k=v') });

    expect(files).toEqual({});
    expect(excludedSecrets).toEqual(['.env']);
  });
});
