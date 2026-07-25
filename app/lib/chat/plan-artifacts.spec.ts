/**
 * The plan-mode writable-folder rule (SPEC §4.2.9).
 *
 * A false NEGATIVE silently re-breaks bt-spec/bt-plan (the skill reports a spec written that does
 * not exist); a false POSITIVE opens plan mode's read-only wall to arbitrary project files. Both
 * directions fail without an error, so both get pinned.
 */
import { describe, expect, it } from 'vitest';
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
