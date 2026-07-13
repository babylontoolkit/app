/**
 * Context-cost guards (SPEC §4.2.8).
 *
 * These are money tests, in the same sense the ledger tests are. A regression here does not throw and
 * does not fail a build — it silently multiplies the input bill of every generation. The measured
 * creation that motivated this file cost 997,775 uncached prompt tokens, roughly half of it minified
 * vendor JavaScript that no correct edit exists for.
 */
import { describe, expect, it } from 'vitest';
import type { FileMap } from '~/lib/stores/files';
import { isOpaqueToModel, stripOpaqueContent } from './opaque-files';

describe('isOpaqueToModel', () => {
  /*
   * The three files below are 129KB of the starter's 258KB text payload. They were being sent to the
   * model twice per turn (creation artifact + file context) and re-sent on every step of the tool
   * loop. If someone ever "simplifies" this list, that cost comes straight back.
   */
  it.each([
    'public/scripts/twgsl.js',
    'public/scripts/pep.js',
    'public/scripts/glslang.js',
    'public/scripts/anything-added-later.js',
  ])('hides the vendor runtime shim %s', (path) => {
    expect(isOpaqueToModel(path)).toBe(true);
  });

  it.each(['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml'])(
    'hides the generated dependency graph %s',
    (path) => {
      expect(isOpaqueToModel(path)).toBe(true);
    },
  );

  /*
   * SVGs are image assets that happen to be text. The landing-page rule (§4.4c) has the model IMPORT
   * images by path, never author them — and `vite.svg` is 9KB of path data for a logo the brand rule
   * forbids it from using at all.
   */
  it.each(['src/assets/vite.svg', 'public/icons.svg', 'public/LOGO.SVG'])('hides the image asset %s', (path) => {
    expect(isOpaqueToModel(path)).toBe(true);
  });

  /*
   * The other half of the contract, and the one that actually matters: everything the agent has to
   * READ to do its job must still reach it. Hiding `globals.ts` or `platform.tsx` would leave the
   * model guessing at the play contract — the exact failure §4.4c exists to prevent.
   */
  it.each([
    'package.json',
    'src/pages/Home.tsx',
    'src/pages/Home.css',
    'src/scripts/KartRacerMode.ts',
    'src/babylon/globals.ts',
    'src/babylon/system/platform.tsx',
    'src/babylon/classes/VehicleControllerDemo.ts',
    'vite.config.ts',
    'index.html',
  ])('shows %s to the model', (path) => {
    expect(isOpaqueToModel(path)).toBe(false);
  });

  it('does not hide a source file merely for living under a public/ path', () => {
    expect(isOpaqueToModel('public/manifest.json')).toBe(false);
  });
});

/**
 * `stripOpaqueContent` trims the map POSTED TO THE SERVER. It must never be confused with trimming
 * the map itself: `workbenchStore.files` is the source every egress path builds from (ZIP export,
 * GitHub sync, snapshot, share build), so a lockfile dropped from it is a lockfile missing from the
 * user's project — and a restored snapshot then re-resolves its dependencies and can install a
 * different tree than the one that was tested.
 */
describe('stripOpaqueContent', () => {
  const LOCKFILE = '{"lockfileVersion":3,"packages":{}}';

  const files: FileMap = {
    '/home/project/package-lock.json': { type: 'file', content: LOCKFILE, isBinary: false },
    '/home/project/public/scripts/twgsl.js': { type: 'file', content: 'var twgsl=(()=>{})();', isBinary: false },
    '/home/project/src/pages/Home.tsx': { type: 'file', content: 'export default function Home() {}', isBinary: false },
    '/home/project/src/assets/hero.png': { type: 'file', content: '', isBinary: true, size: 13057 },
    '/home/project/src': { type: 'folder' },
  };

  it('drops the body of an opaque file but keeps the entry', () => {
    const stripped = stripOpaqueContent(files);
    const lockfile = stripped['/home/project/package-lock.json'];

    expect(lockfile?.type).toBe('file');
    expect(lockfile?.type === 'file' && lockfile.content).toBe('');
  });

  it('records the real size, so the marker the model sees stays truthful', () => {
    const stripped = stripOpaqueContent(files);
    const lockfile = stripped['/home/project/package-lock.json'];

    expect(lockfile?.type === 'file' && lockfile.size).toBe(LOCKFILE.length);
  });

  it('strips vendor shims — the bulk of the freight', () => {
    const stripped = stripOpaqueContent(files);
    const twgsl = stripped['/home/project/public/scripts/twgsl.js'];

    expect(twgsl?.type === 'file' && twgsl.content).toBe('');
  });

  it('leaves source files and folders exactly as they were', () => {
    const stripped = stripOpaqueContent(files);
    const home = stripped['/home/project/src/pages/Home.tsx'];

    expect(home?.type === 'file' && home.content).toBe('export default function Home() {}');
    expect(stripped['/home/project/src']?.type).toBe('folder');
  });

  /*
   * The whole point of the fix. Upstream's watcher dropped the lockfile from the store entirely, so
   * it never reached ANY egress path. Stripping must be a view for the server, never a mutation.
   */
  it('does NOT mutate the source map — egress still sees the real lockfile', () => {
    stripOpaqueContent(files);

    const lockfile = files['/home/project/package-lock.json'];
    expect(lockfile?.type === 'file' && lockfile.content).toBe(LOCKFILE);
  });
});
