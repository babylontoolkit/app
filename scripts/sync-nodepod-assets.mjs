/**
 * Copy Nodepod's browser-served assets out of the installed package into `public/`.
 *
 * WHY THEY CANNOT JUST BE IMPORTED: a service worker's scope cannot rise above its own URL path, and
 * browsers refuse to register one served out of `node_modules`. `__sw__.js` therefore has to sit at
 * the ROOT of our origin — `/__sw__.js` — which on Remix means `public/`. The worker bundle rides
 * along so Nodepod boots workers from a real asset instead of the copy embedded in the library string.
 *
 * 🔴 A HAND-COPIED VENDOR ASSET DRIFTS, SILENTLY. The copy in `public/` is generated, never edited,
 * and `nodepod-assets.spec.ts` asserts it is byte-identical to the installed package's. Bump the
 * dependency without re-running this and the test fails loudly — instead of the app registering a
 * service worker from one version against a runtime from another, which would fail as previews that
 * mysteriously 404 rather than as an error anyone could trace.
 *
 * Run via `pnpm sync:nodepod` (wired into `prepare`, so an install refreshes it).
 */
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(HERE, '..', 'public');

/** Files copied verbatim from the package's `dist` into `public/`. */
export const NODEPOD_PUBLIC_ASSETS = ['__sw__.js', '__worker__.js'];

/**
 * Locate the installed package without deep-importing it.
 *
 * `@scelar/nodepod`'s `exports` map does not expose `./package.json` or `./dist/*`, so
 * `require.resolve('@scelar/nodepod/package.json')` throws. Resolving the package ENTRY and walking
 * up from it is the form that works against an exports-restricted package.
 */
export function nodepodDistDir() {
  const require = createRequire(import.meta.url);
  const entry = require.resolve('@scelar/nodepod');

  return dirname(entry);
}

async function main() {
  const dist = nodepodDistDir();
  await mkdir(PUBLIC_DIR, { recursive: true });

  for (const asset of NODEPOD_PUBLIC_ASSETS) {
    const from = join(dist, asset);
    const to = join(PUBLIC_DIR, asset);

    // Read first so a missing asset fails with the path, not a bare ENOENT from copyFile.
    const bytes = await readFile(from).catch(() => {
      throw new Error(`Nodepod asset missing: ${from}. Did the package layout change?`);
    });

    await copyFile(from, to);
    console.log(`✓ ${asset} → public/ (${bytes.length} bytes)`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(`🔴 sync-nodepod-assets: ${error.message}`);
    process.exit(1);
  });
}
