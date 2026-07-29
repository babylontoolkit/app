/**
 * The plan-mode writable-folder rule (SPEC §4.2.9).
 *
 * A false NEGATIVE silently re-breaks bt-spec/bt-plan (the skill reports a spec written that does
 * not exist); a false POSITIVE opens plan mode's read-only wall to arbitrary project files. Both
 * directions fail without an error, so both get pinned.
 */
import { describe, expect, it } from 'vitest';
import { SANDBOX_ROOTS } from '~/lib/common/sandbox-paths';
import { isPlanArtifactPath, PLAN_ARTIFACTS_DIR } from './plan-artifacts';

describe('isPlanArtifactPath', () => {
  it('accepts the spellings the model actually produces for the _specs folder', () => {
    expect(isPlanArtifactPath('_specs/racing_spec.md')).toBe(true);
    expect(isPlanArtifactPath('_specs/racing_plan.md')).toBe(true);
    expect(isPlanArtifactPath('./_specs/racing_spec.md')).toBe(true);
    expect(isPlanArtifactPath('/_specs/racing_spec.md')).toBe(true);
    expect(isPlanArtifactPath('/home/project/_specs/racing_spec.md')).toBe(true);
    expect(isPlanArtifactPath('_specs/drafts/notes.md')).toBe(true);
    expect(isPlanArtifactPath('  _specs/padded.md  ')).toBe(true);
  });

  it('rejects everything outside the folder — the read-only wall stands', () => {
    expect(isPlanArtifactPath('src/scripts/RacerMode.ts')).toBe(false);
    expect(isPlanArtifactPath('SPEC.md')).toBe(false);
    expect(isPlanArtifactPath('.env')).toBe(false);
    expect(isPlanArtifactPath('package.json')).toBe(false);
  });

  it('rejects traversal — the quarantine has no back door', () => {
    expect(isPlanArtifactPath('_specs/../src/scripts/RacerMode.ts')).toBe(false);
    expect(isPlanArtifactPath('_specs/../../etc/passwd')).toBe(false);
    expect(isPlanArtifactPath('_specs/./x.md')).toBe(false);
    expect(isPlanArtifactPath('_specs//x.md')).toBe(false);
  });

  it('rejects the folder itself, sibling look-alikes, and junk input', () => {
    expect(isPlanArtifactPath('_specs')).toBe(false);
    expect(isPlanArtifactPath('_specs/')).toBe(false);
    expect(isPlanArtifactPath('_specsx/evil.md')).toBe(false);
    expect(isPlanArtifactPath('src/_specs/x.md')).toBe(false);
    expect(isPlanArtifactPath('_specs\\x.md')).toBe(false);
    expect(isPlanArtifactPath('')).toBe(false);
    expect(isPlanArtifactPath(undefined)).toBe(false);
    expect(isPlanArtifactPath(null)).toBe(false);
  });

  it('exports the folder name both halves share', () => {
    expect(PLAN_ARTIFACTS_DIR).toBe('_specs');
  });
});

/**
 * THE ONE DOOR IN THE PLAN WALL OPENS ON EVERY PROVIDER (T7b, SPEC §8, §4.2.9).
 *
 * This rule stripped a `/home/project/` literal. Under a provider rooted elsewhere the root survived,
 * `segments[0]` was `project` rather than `_specs`, and Plan mode REFUSED the very artifact it had just
 * instructed the model to write — the §4.2.9 "the skill reports a spec written that does not exist"
 * defect, reintroduced one provider at a time and visible only as a missing file.
 *
 * The rejections matter as much as the acceptance and are therefore re-run under every root: a fix that
 * opened the door by loosening the segment check (rather than by normalising the root) would pass the
 * acceptance case and hand plan mode's read-only wall a traversal back door. `toProjectRelativePath`
 * strips a ROOT; it does not resolve `..`, so the segment check is still the thing standing there.
 */
describe.each(SANDBOX_ROOTS)('isPlanArtifactPath under the %s root', (root) => {
  it('accepts a plan artifact written with the root attached', () => {
    expect(isPlanArtifactPath(`${root}/_specs/racing_spec.md`)).toBe(true);
    expect(isPlanArtifactPath(`${root}/_specs/racing_plan.md`)).toBe(true);
    expect(isPlanArtifactPath(`${root}/_specs/drafts/notes.md`)).toBe(true);
    expect(isPlanArtifactPath(`  ${root}/_specs/padded.md  `)).toBe(true);
  });

  it('still refuses traversal out of the quarantine', () => {
    expect(isPlanArtifactPath(`${root}/_specs/../src/scripts/RacerMode.ts`)).toBe(false);
    expect(isPlanArtifactPath(`${root}/_specs/../../etc/passwd`)).toBe(false);
    expect(isPlanArtifactPath(`${root}/_specs/./x.md`)).toBe(false);
    expect(isPlanArtifactPath(`${root}/_specs//x.md`)).toBe(false);
  });

  it('still refuses the bare folder, sibling look-alikes, backslashes and ordinary source', () => {
    expect(isPlanArtifactPath(`${root}/_specs`)).toBe(false);
    expect(isPlanArtifactPath(`${root}/_specs/`)).toBe(false);
    expect(isPlanArtifactPath(`${root}/_specsx/evil.md`)).toBe(false);
    expect(isPlanArtifactPath(`${root}/src/_specs/x.md`)).toBe(false);
    expect(isPlanArtifactPath(`${root}\\_specs\\x.md`)).toBe(false);
    expect(isPlanArtifactPath(`${root}/src/scripts/RacerMode.ts`)).toBe(false);
    expect(isPlanArtifactPath(`${root}/.env`)).toBe(false);
  });

  /*
   * The root itself is not a file, and `toProjectRelativePath` deliberately normalises it to the empty
   * string rather than to `home/project` (the trailing-slash rule its doc comment opens with). An empty
   * segment is a rejection here, which is the answer we want either way.
   */
  it('refuses the sandbox root itself', () => {
    expect(isPlanArtifactPath(root)).toBe(false);
    expect(isPlanArtifactPath(`${root}/`)).toBe(false);
  });
});
