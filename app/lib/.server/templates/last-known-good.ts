/**
 * Last-known-good template snapshot (SPEC §4.4 — reliability hardening).
 *
 * New Project fetches the AppTemplate starter LIVE from GitHub at creation time (`api.github-template`,
 * default-branch zipball — see §4.4's "Divergence" note). That live fetch is a single point of failure:
 * GitHub is down, a rate-limit 403, a network blip, or — subtler — a fetch that *succeeds* but returns
 * something structurally unmountable (submodule vendoring failed → no `src/babylon`; a truncated zip).
 * Any of these would fail project creation outright.
 *
 * This module turns that hard failure into graceful degradation: every SUCCESSFUL, VALID fetch is
 * persisted to object storage, and when a later fetch fails or comes back unmountable, the most recent
 * good snapshot is served instead. The user gets a slightly-older-but-working starter rather than a
 * dead New Project button.
 *
 * This is NOT the pin-and-cache design §4.4 specifies (deliberate promotion, `toolkit_version` pinned
 * to a SHA/release, rollback) — it is the small, high-value safety net beneath the live-`main` default.
 * The snapshot is a byte-faithful wire copy of the `TemplateFile[]` the route already returns (base64
 * for binaries), so it round-trips through the WebContainer identically to a live fetch.
 */
import type { ObjectStore } from '~/lib/.server/storage';
import type { TemplateFile } from '~/types/template';

const PREFIX = 'templates/last-known-good';

/** Storage key for a repo's snapshot. `owner/repo` → a flat, filesystem- and S3-safe key. */
export function lastKnownGoodKey(repo: string): string {
  const safe = repo.replace(/[^a-zA-Z0-9._-]/g, '__');
  return `${PREFIX}/${safe}.json`;
}

/**
 * Structural sanity check — the realistic ways a live fetch returns something that will not mount.
 *
 * Deliberately narrow: it asserts the two load-bearing invariants whose absence is a SILENT dead-end
 * (the project compiles to nothing, or Vite fails to resolve the framework), not a full schema. These
 * are the exact historical breakages from §4.4: a missing `package.json` (empty/truncated extraction)
 * and a missing vendored framework (`src/babylon/**` — submodule vendoring failed). A stricter check
 * risks rejecting a legitimately-evolved template and defeating the fallback it guards.
 */
export function validateTemplateFiles(files: unknown): { ok: boolean; reason?: string } {
  if (!Array.isArray(files) || files.length === 0) {
    return { ok: false, reason: 'empty file list' };
  }

  const has = (pred: (f: TemplateFile) => boolean) => files.some((f) => pred(f as TemplateFile));

  if (!has((f) => f?.path === 'package.json')) {
    return { ok: false, reason: 'missing package.json' };
  }

  if (!has((f) => typeof f?.path === 'string' && f.path.startsWith('src/babylon/'))) {
    return { ok: false, reason: 'missing vendored framework (src/babylon)' };
  }

  return { ok: true };
}

/** Persist a validated fetch as the repo's last-known-good snapshot. Best-effort — callers never fail creation on a store error. */
export async function saveLastKnownGood(store: ObjectStore, repo: string, files: TemplateFile[]): Promise<void> {
  const bytes = new TextEncoder().encode(JSON.stringify(files));
  await store.put(lastKnownGoodKey(repo), bytes, 'application/json');
}

/** Load the repo's last-known-good snapshot, or null if none exists / it is unreadable. A miss is a value, not an error. */
export async function loadLastKnownGood(store: ObjectStore, repo: string): Promise<TemplateFile[] | null> {
  const bytes = await store.get(lastKnownGoodKey(repo));

  if (!bytes) {
    return null;
  }

  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    return Array.isArray(parsed) && parsed.length > 0 ? (parsed as TemplateFile[]) : null;
  } catch {
    return null;
  }
}
