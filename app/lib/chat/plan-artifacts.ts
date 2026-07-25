/**
 * Plan-mode's ONE writable folder (SPEC §4.2.9).
 *
 * Plan mode is read-only by guarantee — a `<boltAction type="file">` on a plan turn renders as a
 * proposal and never executes. That wall turned out to block the one write a plan-shaped turn
 * legitimately needs: the bt-spec / bt-plan skills author their planning artifacts
 * (`_specs/<feature>_spec.md`, `_specs/<feature>_plan.md`) as file actions, and the wall silently
 * dropped them — the skill reported a spec written that did not exist.
 *
 * The bypass is a PATH rule, not a skill rule, deliberately: the client cannot reliably know which
 * skill ran while file actions are still streaming (`agentMeta.skillsLoaded` arrives after the text),
 * and a folder is a contract the user can see. On a LIVE plan turn, file actions inside `_specs/`
 * execute; everything else — source files, configs, `.env`, shell commands — still renders as a
 * proposal only. `_specs/` is quarantine by construction: nothing in a project imports from it, so
 * the worst a disobedient plan turn can do is leave a stray markdown file where specs live.
 *
 * Kept import-free so both the client parser and the server's plan-mode note can share it — the
 * folder name appearing in two prose strings is the silent-drift bug `message-marks.ts` exists to
 * prevent, one directory over.
 */

/** The folder plan-mode writes are allowed into. The bt-spec/bt-plan skills' output convention. */
export const PLAN_ARTIFACTS_DIR = '_specs';

/**
 * Is this file path INSIDE the plan-artifacts folder? Strict by design — every rejection here is a
 * file action that stays render-only, never a crash:
 *
 * - accepts `_specs/racing_spec.md`, `./_specs/x.md`, `/_specs/x.md`, `/home/project/_specs/x.md`,
 *   and nested `_specs/drafts/x.md` (all spellings the model actually produces for one folder);
 * - rejects the folder itself, traversal (`_specs/../src/x.ts` — the quarantine must not have a
 *   back door), sibling look-alikes (`_specsx/…`), backslash paths, and anything outside.
 */
export function isPlanArtifactPath(filePath: string | undefined | null): boolean {
  if (!filePath || filePath.includes('\\')) {
    return false;
  }

  let path = filePath.trim();

  // The model writes one folder in several spellings; normalize prefixes, never segments.
  while (path.startsWith('./')) {
    path = path.slice(2);
  }

  if (path.startsWith('/home/project/')) {
    path = path.slice('/home/project/'.length);
  } else if (path.startsWith('/')) {
    path = path.slice(1);
  }

  const segments = path.split('/');

  // Every segment must be a real name — an empty, `.` or `..` segment is a traversal, not a file.
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return false;
  }

  return segments.length >= 2 && segments[0] === PLAN_ARTIFACTS_DIR;
}
