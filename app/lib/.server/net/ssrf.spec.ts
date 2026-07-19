/**
 * The shared SSRF guard used by `/api/web-search` and `/api/git-proxy` (SPEC §5).
 *
 * The exhaustive IP classification lives in `url.spec.ts`; this pins the composed server-side gate:
 * `assertPublicUrl` REFUSES a non-public target (throwing before any DNS lookup, so it is deterministic
 * in CI) and the refusal is a `BlockedUrlError` carrying a 400.
 */
import { describe, expect, it } from 'vitest';
import { assertPublicUrl, BlockedUrlError } from './ssrf';

describe('assertPublicUrl', () => {
  for (const url of [
    'http://localhost/',
    'http://127.0.0.1/',
    'http://169.254.169.254/latest/meta-data/', // cloud metadata
    'http://10.0.0.5/',
    'http://[::1]/',
    'http://[fd12:3456::1]/',
    'ftp://example.com/', // non-http scheme
  ]) {
    it(`rejects ${url}`, async () => {
      await expect(assertPublicUrl(url)).rejects.toBeInstanceOf(BlockedUrlError);
    });
  }

  it('BlockedUrlError carries a 400', () => {
    expect(new BlockedUrlError('x').statusCode).toBe(400);
  });
});
