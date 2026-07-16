/**
 * Per-user, per-provider git tokens — stored server-side, encrypted at rest (SPEC §4.5.4b, §5).
 *
 * ## The rule this file exists to enforce
 *
 * §5: a server route may ACT on a secret, never EMIT one. A git token is exactly that kind of secret —
 * and a worse one than most, because it keeps working off-platform after it leaks, against the user's
 * whole account. So the token enters through the OAuth callback, lives here encrypted, and leaves only
 * as an `Authorization` header inside a provider adapter. **No route may ever return it, and nothing
 * may log it.** `TokenRecord` deliberately has no `toJSON`; if you find yourself wanting one, that is
 * the bug.
 *
 * ## Encryption at rest, and what it is actually worth
 *
 * AES-256-GCM with a key from `GIT_TOKEN_ENCRYPTION_KEY`. Honest about the threat model: the key and
 * the ciphertext both sit in the same deployment, so this does NOT stop an attacker with code
 * execution on our box. What it does stop is the realistic path — a leaked database dump, a stray
 * backup, a support engineer with read access to a table — turning into live write access to every
 * user's source code. That is worth the twenty lines. GCM (not CBC) so the ciphertext is
 * authenticated: a tampered row fails to decrypt rather than silently yielding garbage we would then
 * send to GitHub as a bearer token.
 *
 * ## RLS posture: the table has NO user policy, deliberately
 *
 * Every other user-facing table grants the owner read access (§4.5.5). This one does not — RLS is on
 * and there is no policy at all, so only the service role can touch it. A user has no legitimate
 * reason to read their own encrypted token through the anon key, and "the owner can read it" is one
 * misconfigured client away from the browser holding the very credential we just took out of the
 * browser. See migration `0006`.
 */
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import path from 'node:path';
import { env } from '~/lib/.server/env';
import { platformDataDir } from '~/lib/.server/prompt/store';
import { FsJsonTable } from '~/lib/.server/projects/store';
import { createAdminClient, isSupabaseConfigured } from '~/lib/.server/supabase/client';
import { createScopedLogger } from '~/utils/logger';
import type { GitProviderId } from './provider';

const logger = createScopedLogger('git.tokens');

export interface TokenRecord {
  userId: string;
  provider: GitProviderId;
  accessToken: string;
  refreshToken?: string;

  /** Epoch ms. Absent = does not expire (GitHub OAuth App tokens). */
  expiresAt?: number;

  /** The provider account this token belongs to — shown in the UI so the user knows what is linked. */
  providerLogin: string;
  updatedAt: string;
}

/** What the CLIENT is allowed to know about a connection. Note the absence of the token. */
export interface ConnectionSummary {
  provider: GitProviderId;
  providerLogin: string;
  connectedAt: string;
}

export function toConnectionSummary(record: TokenRecord): ConnectionSummary {
  return { provider: record.provider, providerLogin: record.providerLogin, connectedAt: record.updatedAt };
}

/**
 * The AES key.
 *
 * A dedicated `GIT_TOKEN_ENCRYPTION_KEY` is preferred. Falling back to a hash of the service-role key
 * keeps local dev and a not-yet-fully-configured deployment working (§1.3 principle 0: absent
 * credentials degrade, never crash) — hashed rather than truncated so the key is uniformly 32 bytes
 * whatever the source string looks like.
 */
function encryptionKey(context: unknown): Buffer {
  const configured = env(context, 'GIT_TOKEN_ENCRYPTION_KEY');

  if (configured) {
    /*
     * Hash whatever the operator supplied rather than requiring exactly-32-bytes-base64. A key that is
     * rejected at boot for being 31 bytes is a key someone replaces with a shorter, worse one.
     */
    return createHash('sha256').update(configured).digest();
  }

  const fallback = env(context, 'SUPABASE_SERVICE_ROLE_KEY') ?? 'local-dev-token-key';

  return createHash('sha256').update(`git-tokens:${fallback}`).digest();
}

export function encryptToken(context: unknown, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(context), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);

  // iv.tag.ciphertext — everything decrypt needs, and nothing it does not.
  return [iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ciphertext.toString('base64url')].join(
    '.',
  );
}

export function decryptToken(context: unknown, encoded: string): string | null {
  const [ivPart, tagPart, dataPart] = encoded.split('.');

  if (!ivPart || !tagPart || !dataPart) {
    return null;
  }

  try {
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey(context), Buffer.from(ivPart, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));

    return Buffer.concat([decipher.update(Buffer.from(dataPart, 'base64url')), decipher.final()]).toString('utf-8');
  } catch {
    /*
     * Wrong key (rotated), or a tampered row. Null — never throw and never fall back to treating the
     * ciphertext as a token. The caller turns this into a re-connect prompt, which is the honest
     * outcome: we cannot read the credential, so the user must grant a new one.
     */
    return null;
  }
}

export interface GitTokenStore {
  get(userId: string, provider: GitProviderId): Promise<TokenRecord | null>;
  put(record: TokenRecord): Promise<void>;
  delete(userId: string, provider: GitProviderId): Promise<void>;
  listByUser(userId: string): Promise<TokenRecord[]>;
}

interface StoredRow {
  id: string;
  userId: string;
  provider: GitProviderId;
  accessTokenEncrypted: string;
  refreshTokenEncrypted?: string;
  expiresAt?: number;
  providerLogin: string;
  updatedAt: string;
}

const rowId = (userId: string, provider: GitProviderId) => `${userId}__${provider}`;

/** Filesystem-backed store for local mode (§ Stage 3: local mode is REAL, not a mock). */
export class FsGitTokenStore implements GitTokenStore {
  private readonly _table: FsJsonTable<StoredRow>;
  private readonly _context: unknown;

  constructor(context: unknown, root?: string) {
    this._context = context;
    this._table = new FsJsonTable<StoredRow>(root ?? path.join(platformDataDir(), 'git-tokens'));
  }

  private _toRecord(row: StoredRow): TokenRecord | null {
    const accessToken = decryptToken(this._context, row.accessTokenEncrypted);

    if (!accessToken) {
      return null;
    }

    return {
      userId: row.userId,
      provider: row.provider,
      accessToken,
      refreshToken: row.refreshTokenEncrypted
        ? (decryptToken(this._context, row.refreshTokenEncrypted) ?? undefined)
        : undefined,
      expiresAt: row.expiresAt,
      providerLogin: row.providerLogin,
      updatedAt: row.updatedAt,
    };
  }

  async get(userId: string, provider: GitProviderId): Promise<TokenRecord | null> {
    const row = await this._table.get(rowId(userId, provider));

    return row ? this._toRecord(row) : null;
  }

  async put(record: TokenRecord): Promise<void> {
    await this._table.put({
      id: rowId(record.userId, record.provider),
      userId: record.userId,
      provider: record.provider,
      accessTokenEncrypted: encryptToken(this._context, record.accessToken),
      refreshTokenEncrypted: record.refreshToken ? encryptToken(this._context, record.refreshToken) : undefined,
      expiresAt: record.expiresAt,
      providerLogin: record.providerLogin,
      updatedAt: record.updatedAt,
    });
  }

  async delete(userId: string, provider: GitProviderId): Promise<void> {
    await this._table.remove(rowId(userId, provider));
  }

  async listByUser(userId: string): Promise<TokenRecord[]> {
    const rows = await this._table.all();

    return rows
      .filter((r) => r.userId === userId)
      .map((r) => this._toRecord(r))
      .filter((r): r is TokenRecord => r !== null);
  }
}

/** Supabase-backed store. Uses the ADMIN client: the table has no RLS policy by design (see header). */
export class SupabaseGitTokenStore implements GitTokenStore {
  constructor(private readonly _context: unknown) {}

  private _toRecord(row: Record<string, unknown>): TokenRecord | null {
    const accessToken = decryptToken(this._context, row.access_token_encrypted as string);

    if (!accessToken) {
      return null;
    }

    return {
      userId: row.user_id as string,
      provider: row.provider as GitProviderId,
      accessToken,
      refreshToken: row.refresh_token_encrypted
        ? (decryptToken(this._context, row.refresh_token_encrypted as string) ?? undefined)
        : undefined,
      expiresAt: row.expires_at ? new Date(row.expires_at as string).getTime() : undefined,
      providerLogin: row.provider_login as string,
      updatedAt: row.updated_at as string,
    };
  }

  async get(userId: string, provider: GitProviderId): Promise<TokenRecord | null> {
    const client = await createAdminClient(this._context);
    const { data, error } = await client
      .from('git_tokens')
      .select('*')
      .eq('user_id', userId)
      .eq('provider', provider)
      .maybeSingle();

    if (error || !data) {
      return null;
    }

    return this._toRecord(data);
  }

  async put(record: TokenRecord): Promise<void> {
    const client = await createAdminClient(this._context);

    const { error } = await client.from('git_tokens').upsert(
      {
        user_id: record.userId,
        provider: record.provider,
        access_token_encrypted: encryptToken(this._context, record.accessToken),
        refresh_token_encrypted: record.refreshToken ? encryptToken(this._context, record.refreshToken) : null,
        expires_at: record.expiresAt ? new Date(record.expiresAt).toISOString() : null,
        provider_login: record.providerLogin,
        updated_at: record.updatedAt,
      },
      { onConflict: 'user_id,provider' },
    );

    if (error) {
      // A failed token write means the next save cannot authenticate — never swallow it.
      throw new Error(`Failed to store ${record.provider} connection: ${error.message}`);
    }
  }

  async delete(userId: string, provider: GitProviderId): Promise<void> {
    const client = await createAdminClient(this._context);
    await client.from('git_tokens').delete().eq('user_id', userId).eq('provider', provider);
  }

  async listByUser(userId: string): Promise<TokenRecord[]> {
    const client = await createAdminClient(this._context);
    const { data } = await client.from('git_tokens').select('*').eq('user_id', userId);

    return (data ?? []).map((row) => this._toRecord(row)).filter((r): r is TokenRecord => r !== null);
  }
}

let override: GitTokenStore | null = null;

export function getGitTokenStore(context: unknown): GitTokenStore {
  if (override) {
    return override;
  }

  return isSupabaseConfigured(context) ? new SupabaseGitTokenStore(context) : new FsGitTokenStore(context);
}

/** Test seam, matching `setProjectStore`/`setSnapshotStore`. */
export function setGitTokenStore(store: GitTokenStore | null): void {
  override = store;
}

export { logger as gitTokenLogger };
