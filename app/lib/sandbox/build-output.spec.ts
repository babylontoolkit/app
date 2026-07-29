/**
 * The build-output candidate ORDER (SPEC §4.8, `spec/sandbox-codesandbox.md`).
 *
 * A pure unit over the ONE derivation all three consumers share — publish (§4.8) and both deploy
 * flows. It lives apart from them for the reason the drift below happened: each used to keep its own
 * copy of the list, and the thing that decides WHICH bytes get published is this order.
 *
 * The order is the whole correctness. Two silent failures stacked to produce the bug this pins:
 * `resolveInWorkdir` doubled the probe's workdir-absolute path (so the probe was dead code on the
 * CodeSandbox provider), and the detected path here was rebased with a `'/home/project'` STRING
 * LITERAL — a no-op under any other provider root, so the detected path stayed absolute and resolved
 * to nothing. Publish then quietly succeeded off the `dist` guess for every default project, and
 * shipped NOTHING for a project with a custom `outDir`. Nothing threw at any point.
 */
import { describe, expect, it } from 'vitest';
import { buildOutputCandidates } from './build-output';

describe('buildOutputCandidates', () => {
  it('🔴 puts a custom outDir the probe DETECTED first, ahead of every guess', () => {
    // The only candidate that can be right for a project whose vite config moved the output.
    expect(buildOutputCandidates('/project/workspace/build-out')[0]).toBe('build-out');
  });

  it('rebases the detected path under EITHER provider root — one rule, one place', () => {
    /*
     * `toProjectRelativePath` knows both roots because a file map outlives the provider that produced
     * it. The literal this replaced only ever matched one of them, which is why the failure was
     * per-provider and invisible on the provider it was written against.
     */
    expect(buildOutputCandidates('/project/workspace/dist')[0]).toBe('dist');
    expect(buildOutputCandidates('/home/project/dist')[0]).toBe('dist');
  });

  it('leaves an already-relative detected path alone', () => {
    expect(buildOutputCandidates('build-out')[0]).toBe('build-out');
  });

  it('keeps the fallback guesses behind it — defense in depth for a probe that found nothing', () => {
    expect(buildOutputCandidates('/project/workspace/build-out')).toEqual([
      'build-out',
      'dist',
      'build',
      'out',
      'output',
    ]);
  });

  it('does not offer the detected directory TWICE when it is also a fallback', () => {
    // A duplicate is harmless to the reader but makes the list lie about what was tried.
    expect(buildOutputCandidates('/project/workspace/dist')).toEqual(['dist', 'build', 'out', 'output']);
    expect(buildOutputCandidates('/project/workspace/out')).toEqual(['out', 'dist', 'build', 'output']);
  });

  it('yields only the fallbacks when the probe found nothing', () => {
    for (const nothing of [undefined, '']) {
      expect(buildOutputCandidates(nothing)).toEqual(['dist', 'build', 'out', 'output']);
    }
  });

  it('🔴 never offers the workdir ROOT as a candidate', () => {
    /*
     * `readdir` succeeds on the workdir, so a candidate that normalises to `''` would publish the
     * ENTIRE project — source, `.env` and all — as if it were a build. The empty result must fall
     * through to the guesses instead.
     */
    for (const root of ['/project/workspace', '/home/project', '/']) {
      expect(buildOutputCandidates(root)).toEqual(['dist', 'build', 'out', 'output']);
    }
  });
});
