/**
 * The persistent "build done" banner (`build-done.ts`, owner 2026-10-02) — drawn from the message's saved
 * annotations, so it survives a reload and shows whichever tab was open when the build finished.
 */
import { describe, expect, it } from 'vitest';
import { decideBuildDoneBanner } from './build-done';

const meta = (value: Record<string, unknown>) => [
  { type: 'usage', value: {} },
  { type: 'agentMeta', value },
];

describe('decideBuildDoneBanner', () => {
  it('a finished first build → ready', () => {
    expect(
      decideBuildDoneBanner(
        meta({ creationPhasesCompleted: ['design', 'game', 'frontend'], outcome: { state: 'finished' } }),
      ),
    ).toEqual({ state: 'ready' });
  });

  it('a build whose final game check did not pass is finished but NEVER "ready"', () => {
    expect(
      decideBuildDoneBanner(
        meta({ creationPhasesCompleted: ['design', 'game', 'frontend'], outcome: { state: 'unverified' } }),
      ),
    ).toEqual({ state: 'unverified' });
  });

  it.each([['incomplete'], ['paused']])('a %s outcome shows no done banner', (state) => {
    expect(decideBuildDoneBanner(meta({ creationPhasesCompleted: ['design'], outcome: { state } }))).toBeNull();
  });

  it('CONTROL: an ordinary turn (no phases reported) shows nothing', () => {
    expect(decideBuildDoneBanner(meta({ outcome: { state: 'finished' } }))).toBeNull();
    expect(decideBuildDoneBanner(undefined)).toBeNull();
  });

  it('a malformed phase list is not a build', () => {
    expect(decideBuildDoneBanner(meta({ creationPhasesCompleted: ['design', 'nonsense'] }))).toBeNull();
  });
});
