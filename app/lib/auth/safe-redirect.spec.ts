/**
 * The open-redirect wall and the password floor (SPEC §4.5.1).
 *
 * A false POSITIVE here is an open redirect: a link that genuinely signs the user in and then lands
 * them on a look-alike page, with our domain in the referrer chain. A false NEGATIVE silently drops
 * the preserved intent, which reads as "the Remix button forgot what I clicked". Both fail without an
 * error, so both are pinned — and the hostile inputs are the point, not the happy path.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_REDIRECT, MIN_PASSWORD_LENGTH, passwordProblem, safeRedirect } from './safe-redirect';

describe('safeRedirect', () => {
  it('keeps a same-site path — the preserved intent survives', () => {
    expect(safeRedirect('/')).toBe('/');
    expect(safeRedirect('/remix/abc123')).toBe('/remix/abc123');
    expect(safeRedirect('/chat/9d1f?tab=files')).toBe('/chat/9d1f?tab=files');
    expect(safeRedirect('/gallery#top')).toBe('/gallery#top');
  });

  it('refuses an absolute URL, ours included', () => {
    expect(safeRedirect('https://evil.example/steal')).toBe(DEFAULT_REDIRECT);
    expect(safeRedirect('http://evil.example')).toBe(DEFAULT_REDIRECT);

    /*
     * Refused even though this host is ours: "is this my origin?" is a question whose answer changes
     * with every new environment, and a wrong answer is silent. Root-relative only, always.
     */
    expect(safeRedirect('https://app.babylontoolkit.com/gallery')).toBe(DEFAULT_REDIRECT);
  });

  it('refuses the two shapes that LOOK root-relative and are not', () => {
    // Protocol-relative: the browser reads `evil.example` as the host.
    expect(safeRedirect('//evil.example')).toBe(DEFAULT_REDIRECT);
    expect(safeRedirect('//evil.example/path')).toBe(DEFAULT_REDIRECT);

    // Backslash: normalized to `//` by at least one browser, so it reaches the same place.
    expect(safeRedirect('/\\evil.example')).toBe(DEFAULT_REDIRECT);
  });

  it('refuses a path whose control characters COLLAPSE it into a protocol-relative URL', () => {
    /*
     * 🔴 This is what the strip is for, and it is the ONLY shape that needs it.
     *
     * `"/\n/evil.example"` starts with `/` and NOT with `//`, so a shape check run on the raw string
     * accepts it — and the WHATWG URL parser, which discards tabs and newlines BEFORE parsing, then
     * resolves it as `//evil.example`. Verified against Node's own parser:
     * `new URL('/\n/evil.example', 'https://ours.example').href === 'https://evil.example/'`.
     * Stripping first is what makes this check see what the browser will see.
     */
    expect(safeRedirect('/\n/evil.example')).toBe(DEFAULT_REDIRECT);
    expect(safeRedirect('/\t/evil.example')).toBe(DEFAULT_REDIRECT);
    expect(safeRedirect('/\r/evil.example/steal')).toBe(DEFAULT_REDIRECT);
  });

  it('also refuses the LEADING-control-character variants', () => {
    /*
     * ⚠️ Documentation, NOT coverage of the strip: these are already refused by the `startsWith('/')`
     * test whether or not anything was stripped, so a case built only from them passes with the strip
     * deleted. The first draft of this file was exactly that, and only mutation testing said so — the
     * vacuous-test trap already recorded against `build-failure.ts` and the delivery progress cap,
     * arriving a third time.
     */
    expect(safeRedirect('\n//evil.example')).toBe(DEFAULT_REDIRECT);
    expect(safeRedirect('\t//evil.example')).toBe(DEFAULT_REDIRECT);
    expect(safeRedirect(' //evil.example')).toBe(DEFAULT_REDIRECT);
    expect(safeRedirect(' javascript:alert(1)')).toBe(DEFAULT_REDIRECT);
  });

  it('CONTROL: a padded but genuinely same-site path still survives', () => {
    // Otherwise "refuse everything" passes every assertion above while silently killing the intent.
    expect(safeRedirect('  /remix/abc123  ')).toBe('/remix/abc123');
  });

  it('refuses a scheme that is not a path at all', () => {
    expect(safeRedirect('javascript:alert(1)')).toBe(DEFAULT_REDIRECT);
    expect(safeRedirect('data:text/html,<script>')).toBe(DEFAULT_REDIRECT);
    expect(safeRedirect('mailto:someone@example.com')).toBe(DEFAULT_REDIRECT);
  });

  it('treats missing and empty as "no intent", never as an error', () => {
    expect(safeRedirect(null)).toBe(DEFAULT_REDIRECT);
    expect(safeRedirect(undefined)).toBe(DEFAULT_REDIRECT);
    expect(safeRedirect('')).toBe(DEFAULT_REDIRECT);
  });

  it('is idempotent — three layers apply it and the value must not degrade', () => {
    for (const input of ['/remix/abc', '//evil.example', 'https://evil.example', '\n//evil.example']) {
      expect(safeRedirect(safeRedirect(input))).toBe(safeRedirect(input));
    }
  });
});

describe('passwordProblem', () => {
  it('accepts a password at or above the floor', () => {
    expect(passwordProblem('a'.repeat(MIN_PASSWORD_LENGTH))).toBeNull();
    expect(passwordProblem('a-perfectly-fine-passphrase')).toBeNull();
  });

  it('names what is wrong rather than reporting a bare failure', () => {
    const problem = passwordProblem('a'.repeat(MIN_PASSWORD_LENGTH - 1));

    expect(problem).toContain(String(MIN_PASSWORD_LENGTH));
  });

  it('refuses missing and empty — an absent password is not a short one', () => {
    expect(passwordProblem(undefined)).toBe('A password is required.');
    expect(passwordProblem(null)).toBe('A password is required.');
    expect(passwordProblem('')).toBe('A password is required.');
  });

  it('CONTROL: the floor is above Supabase’s own default, or enforcing it here buys nothing', () => {
    expect(MIN_PASSWORD_LENGTH).toBeGreaterThan(6);
  });
});
