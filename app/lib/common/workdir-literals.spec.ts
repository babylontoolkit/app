/**
 * THE WORKDIR ROOT IS A PROVIDER FACT, AND A LITERAL COPY OF IT IS DEFAULT-DENY (SPEC §8, T7b).
 *
 * `sandbox-paths.ts` opens by explaining that `/home/project/` was hardcoded as a bare string in about
 * ten places, each doing its own `.replace('/home/project/', '')`. That module was written to end the
 * practice — and it did not, because prose cannot fail. Nine more instances were found afterwards, in
 * three separate sweeps, EVERY one of them a silent no-op on a CodeSandbox build:
 *
 *   - the client opaque strip (218KB lockfile POSTed on every turn),
 *   - `CLAUDE.md` promotion (the §4.2 Project Instructions block silently absent),
 *   - Plan mode's `_specs/` bypass (the skill reports a spec written that does not exist),
 *   - the publish checklist normaliser (secret rules surviving only by accident of anchoring),
 *   - the publish + both deploy build-directory derivations (a custom `outDir` publishes nothing).
 *
 * Not one of them threw. So the rule gets a scan, in the `sandbox-seam.spec.ts` / `outbound-enumerate`
 * shape: default-deny, comment-stripped (a post-mortem that NAMES the old literal is documentation,
 * not coupling), with an explicit reason required per exception — and CONTROLS, because a scan that
 * silently matches nothing reports a clean bill of health forever. That trap has been hit twice here.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { SANDBOX_ROOTS } from './sandbox-paths';

const APP_DIR = join(process.cwd(), 'app');

/**
 * Files allowed to contain a workdir root as a literal, each with the reason.
 *
 * Adding an entry is a DECISION, not a formality: everything here is either the rule itself, text
 * shown to a human, or a file on a dead code path. A new path-handling module does not belong.
 */
const ALLOWED: Record<string, string> = {
  'lib/common/sandbox-paths.ts': 'The rule itself — this is where the roots are DEFINED.',

  /*
   * ⚠️ The OTHER definition site, and the one place the two must be kept in step: `SANDBOX_PROVIDER_TRAITS`
   * records the root each runtime writes to, while `SANDBOX_ROOTS` lists every root a map may ever
   * carry. Different jobs — "where does THIS build write?" vs "which prefixes might I have to strip?"
   * — which is why they are not merged. A new provider needs an entry in BOTH.
   *
   * This entry MOVED here from `utils/constants.ts` on 2026-07-31. `WORK_DIR` no longer holds a
   * literal at all: it was `VITE_SANDBOX_PROVIDER === 'codesandbox' ? … : '/home/project'`, the same
   * compare-against-one-id shape `sandbox-runtime.ts` exists to delete, and it is now a lookup into
   * this record. `sandbox-runtime.spec.ts` asserts every workdir here is also in `SANDBOX_ROOTS`, so
   * "keep them in step" is finally a test rather than this sentence.
   */
  'lib/common/sandbox-runtime.ts': 'Defines each provider’s workdir — the per-runtime root, paired with SANDBOX_ROOTS.',

  /*
   * Upstream prompt files on the fail-closed `/api/chat` path (§2.1a hide-don't-delete). They are
   * PROSE sent to a model that never runs, not path handling — and the platform's own prompt is
   * assembled server-side from synced docs (§4.3).
   */
  'lib/common/prompts/prompts.ts': 'Dead upstream prompt text (/api/chat is fail-closed).',
  'lib/common/prompts/new-prompt.ts': 'Dead upstream prompt text (/api/chat is fail-closed).',
  'lib/common/prompts/optimized.ts': 'Dead upstream prompt text (/api/chat is fail-closed).',
  'lib/common/prompts/discuss-prompt.ts': 'Dead upstream prompt text (/api/chat is fail-closed).',

  /*
   * Display cosmetics: a label and a toast. Wrong only in that a CodeSandbox path renders unshortened
   * — the user sees a longer string, nothing computes on it. Worth migrating one day, worth naming now.
   */
  'components/workbench/LockManager.tsx': 'Display-only path shortening in a label and a toast.',
};

/** A post-mortem that quotes the old literal is documentation. Strip comments before deciding. */
function sourceWithoutComments(absPath: string): string {
  return readFileSync(absPath, 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') {
      continue;
    }

    const abs = join(dir, entry);

    if (statSync(abs).isDirectory()) {
      walk(abs, out);
    } else if (/\.tsx?$/.test(abs) && !/\.spec\.tsx?$/.test(abs)) {
      /*
       * SPECS ARE EXCLUDED, deliberately. The fix this scan guards is "run the same input under BOTH
       * roots", so a spec that proves it MUST name both — excluding them is what lets the tests that
       * matter exist. It costs nothing: a literal in a spec cannot reach a user.
       */
      out.push(abs);
    }
  }

  return out;
}

/**
 * Does this source contain a sandbox root as a string literal?
 *
 * Matched against `SANDBOX_ROOTS` rather than a hardcoded `/home/project`, so adding a third provider
 * root extends this guard automatically — the failure this scan exists to prevent is provider-shaped,
 * and a scan that only knows about the FIRST provider would miss the same bug written the other way
 * round (`'/project/workspace/'` hardcoded into a WebContainer-visible path rule).
 */
function workdirLiteralIn(source: string): string | undefined {
  /*
   * 🔴 Matched as a PATH SUBSTRING, not as a quote-prefixed one, and with backslashes removed first.
   *
   * The first draft required the root to sit immediately after a `'`, `"` or backtick. It caught
   * `'/home/project/x'` and was BLIND to the spelling that produced one of the four bugs T7b fixes —
   * `checklist.ts`'s `/^\/?(home\/project\/)?/`, where the slashes are regex-escaped and no quote is
   * adjacent. A scan that cannot see the shape of the bug it was written for is the same trap as a
   * scan that matches nothing, one step subtler; caught by the verifier's probes, which are now
   * controls below.
   *
   * Dropping the leading slash from the root is what makes a bare `home/project/` match too. The
   * price is that PROSE mentioning the path inside a non-comment string now counts — which is why
   * the dead upstream prompt files are allow-listed by name rather than by luck.
   */
  const unescaped = source.replaceAll('\\', '');

  return SANDBOX_ROOTS.find((root) => unescaped.includes(root.replace(/^\//, '')));
}

describe('workdir roots are never string literals outside the one rule', () => {
  const files = walk(APP_DIR);

  it('scans a believable number of files (control: the walker still finds source)', () => {
    // Without this, a broken walk reports "no violations" forever — the exact trap this file warns about.
    expect(files.length).toBeGreaterThan(200);

    // And it must be reading NON-spec source, which is the only thing it can actually protect.
    expect(files.some((abs) => abs.endsWith('lib/common/sandbox-paths.ts'))).toBe(true);
    expect(files.some((abs) => abs.endsWith('.spec.ts'))).toBe(false);
  });

  it('control: the scanner DOES detect a literal when one is present', () => {
    /*
     * The second half of the control. The negative assertion below is only meaningful if the detector
     * can still see anything at all, and both a broken regex and an over-eager comment strip produce
     * a silently-passing suite.
     */
    expect(workdirLiteralIn(`const dir = '/home/project/src';`)).toBe('/home/project');
    expect(workdirLiteralIn(`path.replace("/project/workspace/", '')`)).toBe('/project/workspace');
    expect(workdirLiteralIn('const p = `/home/project/${name}`;')).toBe('/home/project');

    /*
     * The three spellings the first draft of this detector missed, kept as controls because one of
     * them IS `checklist.ts`'s old implementation — the regex form, with escaped slashes and no
     * adjacent quote — and a detector blind to it would have passed T7b while missing its own bug.
     */
    expect(workdirLiteralIn(String.raw`p.replace(/^\/?(home\/project\/)?/, '')`)).toBe('/home/project');
    expect(workdirLiteralIn(`export const probe = 'home/project/';`)).toBe('/home/project');
    expect(workdirLiteralIn('const mid = `${DIR}/home/project/x`;')).toBe('/home/project');

    expect(workdirLiteralIn(`import { toProjectRelativePath } from '~/lib/common/sandbox-paths';`)).toBeUndefined();
  });

  it('control: a comment naming the old literal is NOT a violation', () => {
    const commented = `/* We used to do path.replace('/home/project/', '') here. */\nconst x = 1;`;
    expect(workdirLiteralIn(commented.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''))).toBeUndefined();
  });

  it('🔴 no NEW workdir literal outside the allow-list', () => {
    const violations = files
      .filter((abs) => {
        const key = relative(APP_DIR, abs).replaceAll('\\', '/');
        return !ALLOWED[key] && workdirLiteralIn(sourceWithoutComments(abs));
      })
      .map((abs) => relative(APP_DIR, abs).replaceAll('\\', '/'));

    /*
     * If this fails, the fix is `toProjectRelativePath` — NOT an allow-list entry. Every instance so
     * far has been a silent per-provider break, and the file that introduces one always looks like it
     * is doing something innocuous with a string.
     */
    expect(violations).toEqual([]);
  });

  it('the allow-list has no dead entries (a stale exception hides a real one)', () => {
    for (const key of Object.keys(ALLOWED)) {
      const abs = join(APP_DIR, key);
      expect(
        files.includes(abs) && Boolean(workdirLiteralIn(sourceWithoutComments(abs))),
        `${key} is allow-listed but no longer contains a workdir literal — remove the exception`,
      ).toBe(true);
    }
  });
});
