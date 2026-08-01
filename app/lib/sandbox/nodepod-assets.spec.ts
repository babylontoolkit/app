/**
 * The Nodepod assets in `public/` must be byte-identical to the installed package's.
 *
 * 🔴 **This is the guard that makes the copy safe.** `__sw__.js` cannot be imported — a service
 * worker's scope cannot rise above its own URL path and browsers refuse to register one served from
 * `node_modules` — so it has to be copied to the root of our origin. A copied vendor asset drifts the
 * moment the dependency is bumped, and the failure is not an error: the browser registers a service
 * worker from one version against a runtime from another, and previews 404 with nothing to trace.
 *
 * Bump `@babylonjs-toolkit/nodepod` without running `pnpm sync:nodepod` and this fails loudly instead.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/*
 * Imported RELATIVELY on purpose, and the rule is disabled with that reason rather than worked around.
 * `~/` maps to `app/`, so the sync script — which lives in `scripts/`, because it must run from
 * `prepare` before any app code exists — is not reachable through the alias. Re-declaring the asset
 * list here instead would defeat the entire point: the test would then compare the copy against a
 * second copy of the expectations, and a script that stopped copying a file would still pass.
 */
// eslint-disable-next-line no-restricted-imports
import { NODEPOD_PUBLIC_ASSETS, nodepodDistDir } from '../../../scripts/sync-nodepod-assets.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

describe('Nodepod public assets', () => {
  it.each(NODEPOD_PUBLIC_ASSETS)('public/%s is byte-identical to the installed package', async (asset) => {
    const [installed, published] = await Promise.all([
      readFile(join(nodepodDistDir(), asset)),
      readFile(join(REPO_ROOT, 'public', asset)).catch(() => {
        throw new Error(`public/${asset} is missing — run \`pnpm sync:nodepod\`.`);
      }),
    ]);

    expect(sha(published)).toBe(sha(installed));
  });

  /*
   * CONTROL: without it, a change to the asset list or a resolver that silently returned an empty
   * directory would make the parameterised test above vacuous — zero cases, green suite.
   */
  it('CONTROL: the asset list is non-empty and names the service worker', () => {
    expect(NODEPOD_PUBLIC_ASSETS.length).toBeGreaterThan(0);
    expect(NODEPOD_PUBLIC_ASSETS).toContain('__sw__.js');
  });

  /*
   * The service worker's URL is a contract between `nodepod-boot.ts` and the file's location on disk.
   * A worker served from anywhere but the origin root cannot control the preview paths.
   */
  it('the service worker is served from the origin root', async () => {
    const boot = await readFile(join(REPO_ROOT, 'app/lib/sandbox/nodepod-boot.ts'), 'utf8');

    expect(boot).toContain("SW_URL = '/__sw__.js'");
  });
});
