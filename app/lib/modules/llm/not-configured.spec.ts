/**
 * Log noise is how a real error hides (SPEC §4.2a, §5A).
 *
 * Credits-only ships with one configured provider and ~24 registered ones, so every page load logged
 * ~30 ERROR lines for providers that were never meant to have keys. A genuine failure arrived in the
 * middle of that wall and read as more of the same. These tests pin the classification in both
 * directions — the false-quiet direction is the dangerous one.
 */
import { describe, expect, it } from 'vitest';
import { isNotConfiguredError, messageOf } from './not-configured';

describe('isNotConfiguredError', () => {
  /**
   * ⚠️ Providers throw TWO shapes: most `throw` a bare string, some `throw new Error(...)`. A
   * classifier reading only `error.message` matches half of them and leaves the rest shouting.
   */
  it('matches the bare-string throw (most providers)', () => {
    expect(isNotConfiguredError('Missing Api Key configuration for Google provider')).toBe(true);
    expect(isNotConfiguredError('Missing Api Key configuration for Groq provider')).toBe(true);
  });

  it('matches the Error throw (z-ai, together, openai-like)', () => {
    expect(isNotConfiguredError(new Error('Missing Api Key configuration for Z.ai provider'))).toBe(true);
    expect(isNotConfiguredError(new Error('Missing configuration for Together provider'))).toBe(true);
  });

  /**
   * 🔴 The direction that must never regress. A present-but-rejected key, a provider outage, or a
   * network failure are REAL and the operator has to see them. Going quiet here reproduces the bug
   * this module fixes, one level down and much harder to notice.
   */
  it('does NOT match a real failure', () => {
    expect(isNotConfiguredError('401 Unauthorized: invalid x-api-key')).toBe(false);
    expect(isNotConfiguredError(new Error('Internal error, please try again later'))).toBe(false);
    expect(isNotConfiguredError(new Error('fetch failed'))).toBe(false);
    expect(isNotConfiguredError(new Error('ECONNREFUSED 127.0.0.1:11434'))).toBe(false);
    expect(isNotConfiguredError('rate limit exceeded')).toBe(false);
  });

  it('treats anything unrecognisable as a real error', () => {
    expect(isNotConfiguredError(undefined)).toBe(false);
    expect(isNotConfiguredError(null)).toBe(false);
    expect(isNotConfiguredError({})).toBe(false);
    expect(isNotConfiguredError(42)).toBe(false);
  });
});

describe('messageOf', () => {
  it('reads both throw shapes and degrades on anything else', () => {
    expect(messageOf('plain')).toBe('plain');
    expect(messageOf(new Error('boom'))).toBe('boom');
    expect(messageOf({ message: 'from object' })).toBe('from object');
    expect(messageOf(null)).toBe('');
  });
});
