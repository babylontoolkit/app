/**
 * The chrome zone's path is a contract, and a stale one fails silently (SPEC §4.4c, CLAUDE.md zones).
 *
 * The game's chrome — preloader, splash screen, in-game overlay — lived at `src/babylon/custom/`,
 * then `src/custom/`, and since 2026-08-02 lives at **`src/chrome/`**. That path is stated to the
 * model in the baked prompt (`20-hard-constraints.md` file-zone table and "Chrome rewrites") and in
 * the creation brief, and it has to name the folder the STARTER actually ships.
 *
 * 🔴 When those two disagree, **nothing throws**. The model writes `src/chrome/splash.tsx` into a
 * tree whose file is `src/custom/splash.tsx`; Vite is happy (it is a new, unimported module), the
 * project builds, the dev server runs, and the redesign the user paid for is simply never rendered.
 * The starter's default Babylon-branded splash ships instead — a §2.3 branding violation and a
 * §4.2.8-shaped defect: the failure is invisible and the token count does not move.
 *
 * So this scans every SHIPPED file for the retired path. Docs and specs are excluded because they
 * legitimately narrate the history ("moved from `src/custom`"); the prompt sections are NOT excluded,
 * because they are shipped — they are the bytes the model reads.
 *
 * ⚠️ This spec can only see THIS repo. Two things it cannot check, both of which must move with the
 * templates and are recorded in CLAUDE.md:
 *   • the pinned starter snapshot (§4.4) — an admin must PROMOTE the new template, or generation is
 *     correct and creation still lays down the old tree;
 *   • the synced Agent Reference docs (`babylontoolkit/agent`) — authored externally, owner's fix.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

/** The path the chrome lives at today, and the ones it must never be described by again. */
const CURRENT_ZONE = 'src/chrome';
const RETIRED_ZONES = ['src/custom', 'src/babylon/custom'];

/** Everything git tracks, minus prose that is allowed to narrate the rename. */
function shippedFiles(): string[] {
  const out = execFileSync('git', ['ls-files'], { encoding: 'utf8', maxBuffer: 1 << 26 });

  return out
    .split('\n')
    .filter(Boolean)
    .filter((f) => /\.(ts|tsx|js|jsx|css|scss|json|md)$/.test(f))
    .filter((f) => !f.endsWith('.spec.ts') && !f.endsWith('.spec.tsx'))
    .filter((f) => !/^(SPEC|CLAUDE|GETTING_STARTED|NEW_PROJECT|FORK_BASE|README|DEPLOY|CREDITS)\.md$/.test(f))
    .filter((f) => !f.startsWith('_specs/') && !f.startsWith('spec/') && !f.startsWith('docs/'));
}

describe('the chrome zone path', () => {
  const files = shippedFiles();

  it('scanner control: it is actually reading a meaningful set of files', () => {
    // A scan that silently matches nothing reports a clean bill of health forever.
    expect(files.length).toBeGreaterThan(200);
    expect(files).toContain('app/lib/.server/prompt/sections/20-hard-constraints.md');
    expect(files).toContain('app/lib/registry/create-project.ts');
  });

  it('scanner control: it would notice the retired path if one were present', () => {
    const probe = `the chrome used to live at ${RETIRED_ZONES[0]}/splash.tsx`;
    expect(RETIRED_ZONES.some((zone) => probe.includes(zone))).toBe(true);
  });

  it('is never described by a retired path in any shipped file', () => {
    const offenders: string[] = [];

    for (const file of files) {
      const text = readFileSync(file, 'utf8');

      for (const zone of RETIRED_ZONES) {
        if (text.includes(zone)) {
          offenders.push(`${file} → ${zone}`);
        }
      }
    }

    expect(
      offenders,
      `The chrome lives at ${CURRENT_ZONE}. A shipped file still names a retired path, which silently ` +
        `sends the model's redesign into a folder the starter does not have:\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });

  it('is stated to the model in the baked prompt and the creation brief', () => {
    /*
     * The inverse of the scan above: removing the path entirely would also pass a "no retired path"
     * check, and leave the model with no idea where the chrome is.
     */
    const prompt = readFileSync('app/lib/.server/prompt/sections/20-hard-constraints.md', 'utf8');
    expect(prompt).toContain(`${CURRENT_ZONE}/**`);
    expect(prompt).toContain(`${CURRENT_ZONE}/splash.tsx`);
    expect(prompt).toContain(`${CURRENT_ZONE}/loading.tsx`);
    expect(prompt).toContain(`${CURRENT_ZONE}/overlay.tsx`);

    const brief = readFileSync('app/lib/registry/create-project.ts', 'utf8');
    expect(brief).toContain(`${CURRENT_ZONE}/**`);
  });

  it('keeps the chrome OUTSIDE the read-only framework folder', () => {
    /*
     * The zone was moved out of `src/babylon` precisely so projects could edit it; a path back
     * under the read-only tree would make every chrome rewrite a zone violation.
     */
    expect(CURRENT_ZONE.startsWith('src/babylon')).toBe(false);
  });
});
