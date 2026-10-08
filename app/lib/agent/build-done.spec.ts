/**
 * The persistent "build done" banner (`build-done.ts`, owner 2026-10-02) — drawn from the message's saved
 * annotations, so it survives a reload and shows whichever tab was open when the build finished.
 */
import { describe, expect, it } from 'vitest';
import { decideBuildDoneBanner, formatCreationCost } from './build-done';

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

  it('carries the creation total the server stamped (owner, 2026-10-04)', () => {
    const phases = ['design', 'game', 'frontend'];

    expect(
      decideBuildDoneBanner(
        meta({ creationPhasesCompleted: phases, creationCredits: 1234, outcome: { state: 'finished' } }),
      ),
    ).toEqual({ state: 'ready', credits: 1234 });
    expect(
      decideBuildDoneBanner(
        meta({ creationPhasesCompleted: phases, creationCredits: 80, outcome: { state: 'unverified' } }),
      ),
    ).toEqual({ state: 'unverified', credits: 80 });
  });

  it('CONTROL: a missing or junk total → no credits on the banner', () => {
    for (const creationCredits of [undefined, null, -1, Number.NaN, '12']) {
      expect(
        decideBuildDoneBanner(
          meta({ creationPhasesCompleted: ['design'], creationCredits, outcome: { state: 'finished' } }),
        ),
      ).toEqual({ state: 'ready' });
    }
  });
});

describe('formatCreationCost', () => {
  it('states the total, singular for one', () => {
    expect(formatCreationCost(1234)).toBe('Creating this project cost 1,234 credits in total.');
    expect(formatCreationCost(1)).toBe('Creating this project cost 1 credit in total.');
    expect(formatCreationCost(0)).toBe('Creating this project cost 0 credits in total.');
  });

  it('CONTROL: no total → nothing', () => {
    expect(formatCreationCost(undefined)).toBeUndefined();
  });
});
