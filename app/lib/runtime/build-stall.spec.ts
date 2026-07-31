import { describe, expect, it } from 'vitest';
import { BUILD_STALL_MESSAGE, BUILD_STALL_TIMEOUT_MS, isBuildStalled } from './build-stall';

/**
 * The rule that decides whether a build is slow or dead. It exists because an unbounded wait here
 * left the build action `running` forever, which made `decidePublishReadiness` refuse every later
 * Share and Deploy for the rest of the session — one hang reading as "publishing is broken".
 */
describe('isBuildStalled', () => {
  const now = 1_000_000;

  it('is not stalled while the build is printing', () => {
    expect(isBuildStalled(now, now - 1_000)).toBe(false);
  });

  it('is not stalled one millisecond short of the timeout', () => {
    expect(isBuildStalled(now, now - (BUILD_STALL_TIMEOUT_MS - 1))).toBe(false);
  });

  it('is stalled at exactly the timeout', () => {
    expect(isBuildStalled(now, now - BUILD_STALL_TIMEOUT_MS)).toBe(true);
  });

  it('is stalled well past the timeout', () => {
    expect(isBuildStalled(now, now - BUILD_STALL_TIMEOUT_MS * 10)).toBe(true);
  });

  it('measures SILENCE, not total duration — a long build that keeps printing is healthy', () => {
    const startedAt = now - 60 * 60 * 1000; // an hour ago
    const lastOutputAt = now - 1_000; // but it printed a second ago

    expect(startedAt).toBeLessThan(lastOutputAt);
    expect(isBuildStalled(now, lastOutputAt)).toBe(false);
  });

  it('honours an injected timeout, so the waiter is testable without waiting two minutes', () => {
    expect(isBuildStalled(now, now - 50, 100)).toBe(false);
    expect(isBuildStalled(now, now - 150, 100)).toBe(true);
  });

  /**
   * The message is user-facing and must NOT blame the project: a stalled sandbox sends the user to
   * the editor to hunt for a compile error they do not have.
   */
  it('does not tell the user their project failed to build', () => {
    expect(BUILD_STALL_MESSAGE.toLowerCase()).not.toContain('failed to build');
    expect(BUILD_STALL_MESSAGE.toLowerCase()).toContain('try again');
  });
});
