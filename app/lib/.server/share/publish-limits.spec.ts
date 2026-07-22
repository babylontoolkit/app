/**
 * How the three publish caps relate to each other (SPEC §5, §4.8, §4.5.4c).
 *
 * These are not tests of any one limit — each already refuses correctly on its own, which is exactly
 * how the defect they exist for survived. The bug was in the RELATIONSHIP between three numbers that
 * were each individually right:
 *
 *   - the remix seed capped at 75MB, the working copy at 256MB, chosen separately months apart;
 *   - so a project between them was held for crash recovery, published successfully, and then failed to
 *     seed — leaving a public, playable, permanently **un-remixable** game;
 *   - and because a publish may not fail over its seed, the only trace was a line in a server log.
 *
 * Nothing threw, nothing was red, and the owner would have found out when a stranger clicked Remix on
 * their game and got an empty editor. So the invariants pinned here are agreement invariants: the two
 * SOURCE caps default to the same number, and the body cap follows whatever the caps beneath it are.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PROJECT_SOURCE_MAX_MB } from '~/lib/.server/storage/limits';
import { DEFAULT_WORKING_COPY_MAX_MB, maxWorkingCopyBytes } from '~/lib/.server/projects/working-copy';
import { DEFAULT_REMIX_SEED_MAX_MB, maxSeedBytes } from './seed-store';
import { DEFAULT_BUILD_MAX_MB, maxBuildBytes, maxPublishBodyBytes, publishBodyFloorBytes } from './publish';

const MB = 1024 * 1024;

/*
 * ⚠️ `env()` falls back to `process.env`, and vitest loads `.env.local` — so a developer who has set any
 * of these locally would otherwise be testing their own machine's configuration rather than the
 * defaults. Same trap as `oauth.spec.ts`. Every default assertion stubs the variable away first.
 */
function withNoOverrides() {
  for (const key of ['BUILD_MAX_MB', 'REMIX_SEED_MAX_MB', 'PUBLISH_BODY_MAX_MB', 'WORKING_COPY_MAX_MB']) {
    vi.stubEnv(key, undefined as unknown as string);
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('the two SOURCE caps agree by default', () => {
  /*
   * 🔴 The invariant the defect violated. Both hold the same thing — the user's project — for two
   * different reasons (crash recovery, remix). A project the platform will hold for one it will hold
   * for the other; splitting them is what produced an un-remixable published game.
   */
  it('the working copy and the remix seed share one default', () => {
    expect(DEFAULT_REMIX_SEED_MAX_MB).toBe(DEFAULT_PROJECT_SOURCE_MAX_MB);
    expect(DEFAULT_WORKING_COPY_MAX_MB).toBe(DEFAULT_PROJECT_SOURCE_MAX_MB);
  });

  it('so a project the platform will recover is a project it will seed', () => {
    withNoOverrides();
    expect(maxSeedBytes()).toBe(maxWorkingCopyBytes());
  });

  /* Still independently tunable — an operator may have a reason. They just have to type it. */
  it('honours a deliberate split', () => {
    withNoOverrides();
    vi.stubEnv('REMIX_SEED_MAX_MB', '64');
    expect(maxSeedBytes()).toBe(64 * MB);
    expect(maxWorkingCopyBytes()).toBe(DEFAULT_PROJECT_SOURCE_MAX_MB * MB);
  });

  /*
   * The BUILD cap is deliberately NOT part of this. A built `dist/` is served to the public on every
   * play — different artifact, different economics — so it keeps its own number.
   */
  it('does not drag the build cap along with them', () => {
    expect(DEFAULT_BUILD_MAX_MB).not.toBe(DEFAULT_PROJECT_SOURCE_MAX_MB);
  });
});

describe('the body cap follows the caps it has to clear', () => {
  /*
   * The body carries build + seed, so a hand-picked third number drifts below them the moment either is
   * raised — and then IT does the refusing, naming a limit the operator never touched.
   */
  it('defaults above build + seed', () => {
    withNoOverrides();
    expect(maxPublishBodyBytes()).toBeGreaterThan(publishBodyFloorBytes());
    expect(publishBodyFloorBytes()).toBe(maxBuildBytes() + maxSeedBytes());
  });

  it('rises when either cap beneath it rises — the point of deriving it', () => {
    withNoOverrides();

    const before = maxPublishBodyBytes();

    vi.stubEnv('BUILD_MAX_MB', String(DEFAULT_BUILD_MAX_MB * 4));

    const afterBuild = maxPublishBodyBytes();
    expect(afterBuild).toBeGreaterThan(before);
    expect(afterBuild).toBeGreaterThan(publishBodyFloorBytes());

    vi.stubEnv('REMIX_SEED_MAX_MB', String(DEFAULT_PROJECT_SOURCE_MAX_MB * 4));
    expect(maxPublishBodyBytes()).toBeGreaterThan(afterBuild);
    expect(maxPublishBodyBytes()).toBeGreaterThan(publishBodyFloorBytes());
  });

  /* Silently recomputing a number an operator typed is its own kind of mystery. Theirs wins. */
  it('lets an explicit override win, even a low one', () => {
    withNoOverrides();
    vi.stubEnv('PUBLISH_BODY_MAX_MB', '10');
    expect(maxPublishBodyBytes()).toBe(10 * MB);
    expect(maxPublishBodyBytes()).toBeLessThan(publishBodyFloorBytes());
  });

  it.each(['0', '-5', 'plenty', ''])('ignores a nonsense override (%s) and derives instead', (raw) => {
    withNoOverrides();
    vi.stubEnv('PUBLISH_BODY_MAX_MB', raw);
    expect(maxPublishBodyBytes()).toBeGreaterThan(publishBodyFloorBytes());
  });
});
