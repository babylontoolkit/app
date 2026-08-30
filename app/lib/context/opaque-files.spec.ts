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
import { SANDBOX_ROOTS } from '~/lib/common/sandbox-paths';
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

  /*
   * A root `license.json` is machine-generated crypto that ships with the project but must never be
   * rewritten by the model. The licenser that generated it was removed 2026-08-30 (SPEC §4.18) and this
   * rule STAYS: an imported or cloned project can still carry one, and un-hiding it would feed those
   * bytes to the model on every turn — a context regression that throws nothing (§4.2.8). It matches at
   * the root ONLY — a `src/license.json` is a source file the agent may legitimately author, so the
   * exact-path rule (same as the lockfile) is required.
   */
  it('hides a root license.json', () => {
    expect(isOpaqueToModel('license.json')).toBe(true);
  });

  it('does NOT hide a nested license.json (only the root one is machine-generated)', () => {
    expect(isOpaqueToModel('src/license.json')).toBe(false);
    expect(isOpaqueToModel('public/license.json')).toBe(false);
  });

  /*
   * `.codesandbox/` is the sandbox PROVIDER's directory (T9): the task config the template's dev
   * server boots from, and the project-identity sentinel the warm-boot gate reads through provider
   * `fs`. It is excluded at the MAP layer, so this is the second wall — any ingest path that fills
   * context without going through the map (an import, a restore, a future one) still must not show
   * the model infrastructure it did not write. And the model editing it is not harmless: deleting
   * `tasks.json` stops the port task from ever starting.
   */
  it.each(['.codesandbox/tasks.json', '.codesandbox/btk-project.json', '.codesandbox/anything-added-later.json'])(
    'hides the provider’s own file %s',
    (path) => {
      expect(isOpaqueToModel(path)).toBe(true);
    },
  );

  /*
   * Opaque directories are a root-relative PREFIX rule (same as `public/scripts/`), so a same-named
   * or similarly-named path elsewhere in the user's project stays fully visible. A rule widened to
   * `includes('.codesandbox')` would pass every assertion above and silently blind the model to a
   * source file it is expected to edit — the §4.2.8 failure that throws nothing and only degrades
   * output quality.
   */
  it.each(['src/.codesandboxish.ts', 'src/codesandbox.ts', 'public/codesandbox-notes.md'])(
    'still shows %s to the model',
    (path) => {
      expect(isOpaqueToModel(path)).toBe(false);
    },
  );
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

/**
 * THE STRIP IS PROVIDER-NEUTRAL, OR IT IS A NO-OP (T7b, SPEC §8).
 *
 * This function used to take a `workdir` parameter defaulting to `'/home/project/'`, and its ONE caller
 * (`Chat.client.tsx`) always used the default. Under a provider rooted anywhere else — CodeSandbox puts
 * the project at `/project/workspace` — the prefix matched nothing, `isOpaqueToModel` was handed an
 * ABSOLUTE path, every rule failed, and the whole strip silently became a no-op: the 218KB lockfile and
 * the vendored `public/scripts/*` bodies went back on the wire on EVERY turn. Nothing threw; the server
 * strip still protected the model; the only symptom was a bigger POST.
 *
 * So the same inputs run under EVERY root in `SANDBOX_ROOTS` — imported, never re-typed, so a third
 * provider is covered the day its root is added rather than the day someone remembers this file.
 */
describe.each(SANDBOX_ROOTS)('stripOpaqueContent under the %s root', (root) => {
  const LOCKFILE = '{"lockfileVersion":3,"packages":{}}';
  const SHIM = 'var twgsl=(()=>{})();';
  const SVG = '<svg viewBox="0 0 32 32"><path d="M0 0h32v32H0z"/></svg>';
  const SOURCE = 'export default function Home() {}';

  const files: FileMap = {
    [`${root}/package-lock.json`]: { type: 'file', content: LOCKFILE, isBinary: false },
    [`${root}/public/scripts/twgsl.js`]: { type: 'file', content: SHIM, isBinary: false },
    [`${root}/src/assets/vite.svg`]: { type: 'file', content: SVG, isBinary: false },
    [`${root}/src/pages/Home.tsx`]: { type: 'file', content: SOURCE, isBinary: false },
    [`${root}/src`]: { type: 'folder' },
  };

  it.each(['package-lock.json', 'public/scripts/twgsl.js', 'src/assets/vite.svg'])(
    'strips the body of %s',
    (relativePath) => {
      const dirent = stripOpaqueContent(files)[`${root}/${relativePath}`];

      expect(dirent?.type).toBe('file');
      expect(dirent?.type === 'file' && dirent.content).toBe('');
    },
  );

  /*
   * The marker the model DOES see quotes this number. A strip that reported the post-strip length would
   * tell the model every opaque file is 0 bytes — truthful-looking, and wrong about the one fact it is
   * allowed to know.
   */
  it('keeps a truthful size on the entry it emptied', () => {
    const stripped = stripOpaqueContent(files);
    const lockfile = stripped[`${root}/package-lock.json`];
    const svg = stripped[`${root}/src/assets/vite.svg`];

    expect(lockfile?.type === 'file' && lockfile.size).toBe(LOCKFILE.length);
    expect(svg?.type === 'file' && svg.size).toBe(SVG.length);
  });

  /*
   * The other half of §4.2.8: everything the agent must READ has to survive. A root-blind rule that
   * over-matched would be just as silent as one that under-matched, and far more expensive in quality.
   */
  it('leaves source files and folders exactly as they were', () => {
    const stripped = stripOpaqueContent(files);
    const home = stripped[`${root}/src/pages/Home.tsx`];

    expect(home?.type === 'file' && home.content).toBe(SOURCE);
    expect(stripped[`${root}/src`]?.type).toBe('folder');
  });

  it('never mutates the source map — every egress path still builds from it', () => {
    stripOpaqueContent(files);

    const lockfile = files[`${root}/package-lock.json`];
    expect(lockfile?.type === 'file' && lockfile.content).toBe(LOCKFILE);
  });
});

/**
 * The provider directory, under EVERY root (T9).
 *
 * It is normally pruned at the map layer, so nothing here should ever have anything to do — which is
 * precisely why it is worth pinning: the second wall is only load-bearing on the day the first one is
 * bypassed, and on that day nothing throws. Run under both roots for the same reason the block above
 * does: a root-blind prefix rule silently degrades to a no-op on the provider it was not written for.
 */
describe.each(SANDBOX_ROOTS)('stripOpaqueContent hides the provider directory under the %s root', (root) => {
  const TASKS = '{"tasks":{"dev":{"command":"npm run dev"}}}';
  const SOURCE = 'export const x = 1;';

  const files: FileMap = {
    [`${root}/.codesandbox/tasks.json`]: { type: 'file', content: TASKS, isBinary: false },
    [`${root}/.codesandbox/btk-project.json`]: { type: 'file', content: '{"projectId":"p1"}', isBinary: false },
    [`${root}/src/.codesandboxish.ts`]: { type: 'file', content: SOURCE, isBinary: false },
  };

  it.each(['.codesandbox/tasks.json', '.codesandbox/btk-project.json'])('strips the body of %s', (relativePath) => {
    const dirent = stripOpaqueContent(files)[`${root}/${relativePath}`];

    expect(dirent?.type === 'file' && dirent.content).toBe('');
  });

  /*
   * CONTROL: a similarly-named SOURCE file is untouched, so the rule above is narrow rather than a
   * substring match that would blind the model to the user's own code.
   */
  it('leaves a similarly-named source file alone', () => {
    const dirent = stripOpaqueContent(files)[`${root}/src/.codesandboxish.ts`];

    expect(dirent?.type === 'file' && dirent.content).toBe(SOURCE);
  });
});
