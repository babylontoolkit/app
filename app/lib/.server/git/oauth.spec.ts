/**
 * OAuth state, config, and token encryption (SPEC §4.5.4b, §5).
 *
 * Everything here is a security path, and each has a silent failure mode:
 *   - a forgeable `state` lets an attacker file THEIR token against YOUR account, so their repo
 *     becomes the permanent home of your project;
 *   - an unsanitised `returnTo` turns our own signed URL into an open redirect;
 *   - a token that round-trips wrong is a save that fails at 3am with no way to tell why.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildAuthorizeUrl,
  configuredProviders,
  getOAuthConfig,
  isProviderConfigured,
  oauthRedirectUri,
  providerEndpoints,
  safeReturnTo,
  signState,
  verifyState,
  type OAuthState,
} from './oauth';
import { decryptToken, encryptToken } from './token-store';

/** A fake Remix/CF context — `env()` reads `context.cloudflare.env` before `process.env`. */
const ctx = (vars: Record<string, string>) => ({ cloudflare: { env: vars } });

/**
 * 🔴 `ctx({})` does not mean "nothing is configured", and that is the whole reason this block exists.
 *
 * `env()` falls back to `process.env` (it must — that is how we run on Node as well as Cloudflare), and
 * vitest loads `.env.local`. So on a developer's machine with real OAuth apps set up, an "empty"
 * context silently resolved their actual credentials, and every assertion here about the UNCONFIGURED
 * state failed — while CI, which has no `.env.local`, stayed green.
 *
 * That is the worst shape a test failure can take: it fires only for the person who configured the
 * feature, blames code they did not touch, and teaches them that a red suite is normal. Worse, the
 * property under test — "absent credentials degrade, never crash" — became unverifiable on the only
 * machines where anyone would notice it breaking.
 *
 * So the environment is emptied explicitly. These tests are about what the CONTEXT says, and nothing
 * else may answer for it.
 */
const OAUTH_ENV_KEYS = [
  'GITHUB_OAUTH_CLIENT_ID',
  'GITHUB_OAUTH_CLIENT_SECRET',
  'GITLAB_OAUTH_CLIENT_ID',
  'GITLAB_OAUTH_CLIENT_SECRET',
  'GITLAB_HOST',
  'GIT_OAUTH_STATE_SECRET',
  'GIT_TOKEN_ENCRYPTION_KEY',
  'APP_URL',
];

beforeEach(() => {
  for (const key of OAUTH_ENV_KEYS) {
    vi.stubEnv(key, undefined as unknown as string);
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const SECRET = { GIT_OAUTH_STATE_SECRET: 'a-server-only-signing-secret' };

const state = (over: Partial<OAuthState> = {}): OAuthState => ({
  userId: 'user-1',
  provider: 'github',
  returnTo: '/chat/abc',
  issuedAt: Date.now(),
  nonce: 'n1',
  ...over,
});

describe('provider configuration — absent credentials degrade, never crash', () => {
  it('reports a provider as not configured when its OAuth app is missing', () => {
    expect(getOAuthConfig(ctx({}), 'github')).toBeNull();
    expect(isProviderConfigured(ctx({}), 'github')).toBe(false);
    expect(configuredProviders(ctx({}))).toEqual([]);
  });

  /**
   * The control for the `stubEnv` block above — it makes the trap visible instead of merely avoided.
   *
   * `env()` really does fall back to `process.env`, by design: it is how the same call sites work on
   * Node and on Cloudflare. The consequence is that an "empty" context is empty only while the
   * environment is, which is why the tests above must clear it. If someone deletes that `beforeEach`,
   * CI still passes (no `.env.local` there) and the suite silently starts failing for exactly the
   * developers who have OAuth set up. This test states the mechanism so the next reader does not have
   * to rediscover it from a confusing red run.
   */
  it('falls back to process.env when the context does not answer — hence the stubs above', () => {
    vi.stubEnv('GITHUB_OAUTH_CLIENT_ID', 'from-the-environment');
    vi.stubEnv('GITHUB_OAUTH_CLIENT_SECRET', 'also-from-the-environment');

    expect(getOAuthConfig(ctx({}), 'github')?.clientId).toBe('from-the-environment');
  });

  /** The context is authoritative when it answers — the environment must not override a real config. */
  it('prefers the context over the environment', () => {
    vi.stubEnv('GITHUB_OAUTH_CLIENT_ID', 'from-the-environment');
    vi.stubEnv('GITHUB_OAUTH_CLIENT_SECRET', 'also-from-the-environment');

    const context = ctx({ GITHUB_OAUTH_CLIENT_ID: 'from-the-context', GITHUB_OAUTH_CLIENT_SECRET: 'shh' });

    expect(getOAuthConfig(context, 'github')?.clientId).toBe('from-the-context');
  });

  it('needs BOTH id and secret — half a config is no config', () => {
    expect(getOAuthConfig(ctx({ GITHUB_OAUTH_CLIENT_ID: 'id' }), 'github')).toBeNull();
    expect(getOAuthConfig(ctx({ GITHUB_OAUTH_CLIENT_SECRET: 'sh' }), 'github')).toBeNull();
  });

  it('lists exactly the providers the operator configured', () => {
    const context = ctx({
      GITHUB_OAUTH_CLIENT_ID: 'id',
      GITHUB_OAUTH_CLIENT_SECRET: 'secret',
    });

    expect(configuredProviders(context)).toEqual(['github']);

    const both = ctx({
      GITHUB_OAUTH_CLIENT_ID: 'id',
      GITHUB_OAUTH_CLIENT_SECRET: 'secret',
      GITLAB_OAUTH_CLIENT_ID: 'id2',
      GITLAB_OAUTH_CLIENT_SECRET: 'secret2',
    });

    expect(configuredProviders(both)).toEqual(['github', 'gitlab']);
  });

  it('points GitLab at a self-hosted host when configured', () => {
    const context = ctx({
      GITLAB_OAUTH_CLIENT_ID: 'id',
      GITLAB_OAUTH_CLIENT_SECRET: 'secret',
      GITLAB_HOST: 'https://gitlab.acme.internal',
    });

    expect(getOAuthConfig(context, 'gitlab')?.host).toBe('https://gitlab.acme.internal');
    expect(providerEndpoints('gitlab', 'https://gitlab.acme.internal').authorizeUrl).toBe(
      'https://gitlab.acme.internal/oauth/authorize',
    );
  });
});

describe('scopes — minimal, and honest about where they are not', () => {
  it('asks GitHub for repo — the narrowest OAuth App scope that can write a PRIVATE repo', () => {
    expect(providerEndpoints('github').scope).toBe('repo');
  });

  /**
   * Documented over-grant, asserted so it cannot be widened silently and cannot be narrowed by
   * someone who has not checked that project creation still works. `write_repository` cannot create
   * a project, and Save must create the repo.
   */
  it('asks GitLab for api — no narrower scope can CREATE the project Save needs', () => {
    expect(providerEndpoints('gitlab').scope).toBe('api');
  });
});

describe('state — the wall between "this code" and "this user"', () => {
  it('round-trips a signed state', () => {
    const context = ctx(SECRET);
    const original = state();
    const result = verifyState(context, signState(context, original));

    expect(result).toMatchObject({ ok: true, state: { userId: 'user-1', provider: 'github' } });
  });

  it('REJECTS a tampered payload — you cannot swap the user id', () => {
    const context = ctx(SECRET);
    const signed = signState(context, state());
    const [, signature] = signed.split('.');

    // Re-encode the payload with someone else's id, keep the (now wrong) signature.
    const forged = Buffer.from(JSON.stringify(state({ userId: 'victim' })), 'utf-8').toString('base64url');

    expect(verifyState(context, `${forged}.${signature}`)).toMatchObject({ ok: false, reason: 'bad-signature' });
  });

  it('REJECTS a state signed with a different secret', () => {
    const signed = signState(ctx({ GIT_OAUTH_STATE_SECRET: 'attacker-secret' }), state());

    expect(verifyState(ctx(SECRET), signed)).toMatchObject({ ok: false, reason: 'bad-signature' });
  });

  it.each(['', 'nodot', 'a.b.c.d', '.', 'x.'])('rejects malformed state %j without throwing', (raw) => {
    expect(verifyState(ctx(SECRET), raw).ok).toBe(false);
  });

  it('does not throw on a signature of a different LENGTH (timingSafeEqual would)', () => {
    const context = ctx(SECRET);
    const [payload] = signState(context, state()).split('.');

    expect(() => verifyState(context, `${payload}.short`)).not.toThrow();
    expect(verifyState(context, `${payload}.short`)).toMatchObject({ ok: false, reason: 'bad-signature' });
  });

  it('EXPIRES an old state so a captured authorize URL cannot be replayed later', () => {
    const context = ctx(SECRET);
    const now = Date.now();
    const signed = signState(context, state({ issuedAt: now - 11 * 60 * 1000 }));

    expect(verifyState(context, signed, now)).toMatchObject({ ok: false, reason: 'expired' });
  });

  it('rejects a state issued in the future — a clock-skew forgery attempt', () => {
    const context = ctx(SECRET);
    const now = Date.now();
    const signed = signState(context, state({ issuedAt: now + 10 * 60 * 1000 }));

    expect(verifyState(context, signed, now)).toMatchObject({ ok: false, reason: 'expired' });
  });
});

describe('returnTo — never an open redirect', () => {
  it.each([
    ['https://evil.example/steal', '/'],
    ['//evil.example/steal', '/'],
    ['http://evil.example', '/'],
    ['javascript:alert(1)', '/'],
    [undefined, '/'],
    ['', '/'],
  ])('flattens %j to %j', (input, expected) => {
    expect(safeReturnTo(input as string | undefined)).toBe(expected);
  });

  it('keeps a same-site path', () => {
    expect(safeReturnTo('/chat/abc?x=1')).toBe('/chat/abc?x=1');
  });

  it('sanitises returnTo BEFORE signing — we must never sign an open redirect', () => {
    const context = ctx(SECRET);

    const url = buildAuthorizeUrl({
      context,
      provider: 'github',
      config: { clientId: 'id', clientSecret: 'secret' },
      appUrl: 'https://app.example.com',
      state: state({ returnTo: 'https://evil.example' }),
    });

    const signed = new URL(url).searchParams.get('state')!;
    const verified = verifyState(context, signed);

    expect(verified).toMatchObject({ ok: true, state: { returnTo: '/' } });
  });
});

describe('the authorize URL', () => {
  const config = { clientId: 'client-123', clientSecret: 'never-in-a-url' };

  it('carries client_id, redirect_uri, scope and state — and NOT the client secret', () => {
    const url = new URL(
      buildAuthorizeUrl({
        context: ctx(SECRET),
        provider: 'github',
        config,
        appUrl: 'https://app.example.com',
        state: state(),
      }),
    );

    expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('client-123');
    expect(url.searchParams.get('redirect_uri')).toBe('https://app.example.com/api/git/callback/github');
    expect(url.searchParams.get('scope')).toBe('repo');
    expect(url.searchParams.get('state')).toBeTruthy();

    // §5: a secret never reaches a URL — it would land in browser history and every proxy log.
    expect(url.toString()).not.toContain('never-in-a-url');
  });

  it('sets response_type=code for GitLab, which requires it explicitly', () => {
    const url = new URL(
      buildAuthorizeUrl({
        context: ctx(SECRET),
        provider: 'gitlab',
        config,
        appUrl: 'https://app.example.com',
        state: state({ provider: 'gitlab' }),
      }),
    );

    expect(url.searchParams.get('response_type')).toBe('code');
  });

  it('builds the callback URI without a double slash when APP_URL has a trailing one', () => {
    expect(oauthRedirectUri('https://app.example.com/', 'github')).toBe(
      'https://app.example.com/api/git/callback/github',
    );
  });
});

describe('token encryption at rest', () => {
  const context = ctx({ GIT_TOKEN_ENCRYPTION_KEY: 'a-32-plus-byte-operator-supplied-key' });

  it('round-trips a token', () => {
    const token = 'gho_averysecrettokenvalue';

    expect(decryptToken(context, encryptToken(context, token))).toBe(token);
  });

  it('produces different ciphertext each time — a random IV, not ECB', () => {
    const a = encryptToken(context, 'same-token');
    const b = encryptToken(context, 'same-token');

    expect(a).not.toBe(b);
    expect(decryptToken(context, a)).toBe(decryptToken(context, b));
  });

  it('never contains the plaintext', () => {
    expect(encryptToken(context, 'gho_secret')).not.toContain('gho_secret');
  });

  it('REFUSES a tampered ciphertext rather than returning garbage — GCM is authenticated', () => {
    const encrypted = encryptToken(context, 'gho_secret');
    const [iv, tag, data] = encrypted.split('.');

    // Flip a byte in the ciphertext; the auth tag no longer matches.
    const tampered = Buffer.from(data, 'base64url');
    tampered[0] ^= 0xff;

    expect(decryptToken(context, `${iv}.${tag}.${tampered.toString('base64url')}`)).toBeNull();
  });

  it('returns null (never throws) for a token encrypted under a DIFFERENT key', () => {
    const encrypted = encryptToken(context, 'gho_secret');
    const rotated = ctx({ GIT_TOKEN_ENCRYPTION_KEY: 'an-entirely-different-operator-key' });

    /*
     * Key rotation must degrade to "reconnect", not to a 500 on every save. `resolveProvider` turns a
     * null here into the re-connect prompt.
     */
    expect(decryptToken(rotated, encrypted)).toBeNull();
  });

  it.each(['', 'notencrypted', 'a.b', 'a.b.!!!not-base64!!!'])('returns null for malformed input %j', (raw) => {
    expect(decryptToken(context, raw)).toBeNull();
  });

  it('accepts an operator key of any length — a rejected key gets replaced with a worse one', () => {
    const short = ctx({ GIT_TOKEN_ENCRYPTION_KEY: 'short' });

    expect(decryptToken(short, encryptToken(short, 'tok'))).toBe('tok');
  });
});
