/**
 * Template pin-and-cache (SPEC §4.4 — the TARGET design, replacing live-`main` tracking).
 *
 * Until now every New Project fetched the AppTemplate zipball LIVE from GitHub's default branch. That
 * meant a push to `main` reached the next new project with no review step, `toolkit_version` was
 * metadata enforced against nothing, project creation carried a runtime GitHub dependency, and a bad
 * push broke every new project at once with no way back. `last-known-good.ts` was a net under that —
 * it catches a fetch that FAILS or returns something unmountable — but it is not version isolation:
 * a push that is broken in a way the structural check cannot see (it compiles, it just doesn't work)
 * still ships to every user immediately.
 *
 * This module is the pin. A snapshot is fetched ONCE, stored byte-faithfully under its commit SHA, and
 * new projects mount THAT — not whatever `main` says today. Moving to a newer snapshot is a deliberate
 * admin promotion, and rollback is re-pointing the pin at any snapshot still in the store.
 *
 * **Snapshots are immutable and keyed by SHA.** Never overwrite one: the pin's entire value is that the
 * bytes behind a SHA cannot change under you, which is exactly what rollback depends on.
 *
 * This also defuses the §4.4 release-lock footgun. `releases/latest` silently outranking `main` used to
 * mean publishing ANY GitHub Release on AppTemplate instantly changed what new projects mounted. With a
 * pin, publishing a release changes nothing until someone promotes it — the pin is the only thing that
 * decides, and it says which ref it came from.
 */
import type { ObjectStore } from '~/lib/.server/storage';
import type { TemplateFile } from '~/types/template';

const SNAPSHOT_PREFIX = 'templates/snapshots';
const PIN_PREFIX = 'templates/pins';

/** `owner/repo` → a flat key segment that is safe for both S3 and a filesystem. */
function safeRepo(repo: string): string {
  return repo.replace(/[^a-zA-Z0-9._-]/g, '__');
}

/** A snapshot is addressed by the commit it came from — that is what makes it immutable. */
export function snapshotKey(repo: string, sha: string): string {
  return `${SNAPSHOT_PREFIX}/${safeRepo(repo)}/${safeRepo(sha)}.json`;
}

export function pinKey(repo: string): string {
  return `${PIN_PREFIX}/${safeRepo(repo)}.json`;
}

export interface TemplatePin {
  repo: string;

  /** The commit the pinned snapshot was fetched at. The snapshot lives at `snapshotKey(repo, sha)`. */
  sha: string;

  /** Where the SHA came from — `main`, `release:v1.2.0`. Recorded so a promotion is auditable, not guessed. */
  ref: string;

  /** When this pin was set (ISO). */
  pinnedAt: string;

  /** 'auto' for the bootstrap pin, or the admin action that set it. Never a secret. */
  pinnedBy: 'auto' | 'promote' | 'rollback';

  fileCount: number;
}

/**
 * What a template request should be served from.
 *
 * PURE, and exhaustively tested (`pin.spec.ts`), for the same reason `restore-target.ts` is: it decides
 * which BYTES land in a user's brand-new project, and every way it can be wrong is silent. Nobody sees
 * "we served last week's starter" — they see a project that behaves oddly and blame the agent.
 */
/** Serve the pinned snapshot. No network call — this is the whole point of pinning. */
export interface PinnedSource {
  kind: 'pinned';
  sha: string;
}

/** Serve the last-known-good snapshot (client reported a broken mount, or a live fetch is unusable). */
export interface LastKnownGoodSource {
  kind: 'last-known-good';
}

/** Fetch from GitHub. `pinAfter` bootstraps the very first pin, so pinning is not inert until an admin acts. */
export interface LiveSource {
  kind: 'live';
  pinAfter: boolean;
}

export type TemplateSource = PinnedSource | LastKnownGoodSource | LiveSource;

export interface TemplateSourceInput {
  /** The repo's current pin, if any. */
  pin: TemplatePin | null;

  /** Whether the pinned snapshot's bytes are actually still in the store. A pin to a deleted object is not a pin. */
  pinnedSnapshotExists: boolean;

  /** `?fallback=1` — the client mounted a template and found it broken at runtime. */
  preferFallback: boolean;

  /** `TEMPLATE_PINNING_ENABLED`. Off = the old live-`main` behaviour, for template development. */
  pinningEnabled: boolean;
}

export function decideTemplateSource(input: TemplateSourceInput): TemplateSource {
  /*
   * The client's explicit "this mount is broken" beats everything, INCLUDING a healthy pin. The server
   * cannot see a runtime-broken WebContainer, so this is the only signal that a snapshot which passes
   * every structural check still does not work. Honouring the pin here would hand the user the same
   * broken bytes again, forever.
   */
  if (input.preferFallback) {
    return { kind: 'last-known-good' };
  }

  if (!input.pinningEnabled) {
    // Explicitly opted out: track live `main`, and do not quietly create a pin behind their back.
    return { kind: 'live', pinAfter: false };
  }

  /*
   * A pin whose snapshot is GONE (bucket lifecycle rule, a botched cleanup) must not fail creation — but
   * it must not silently re-pin to today's `main` either, because that is exactly the unreviewed jump to
   * live the pin exists to prevent. Serve live for this request; leave the pin alone for an admin to see.
   */
  if (input.pin) {
    return input.pinnedSnapshotExists ? { kind: 'pinned', sha: input.pin.sha } : { kind: 'live', pinAfter: false };
  }

  /*
   * No pin yet — the bootstrap. Fetch live and pin the result: there is nothing older to protect, and
   * live `main` is what this request would have got anyway. From here on the pin holds until promoted,
   * so creation stops depending on GitHub being up.
   */
  return { kind: 'live', pinAfter: true };
}

export async function readPin(store: ObjectStore, repo: string): Promise<TemplatePin | null> {
  const bytes = await store.get(pinKey(repo));

  if (!bytes) {
    return null;
  }

  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as TemplatePin;
    return parsed?.sha ? parsed : null;
  } catch {
    // A corrupt pin is a missing pin, not an outage.
    return null;
  }
}

export async function writePin(store: ObjectStore, pin: TemplatePin): Promise<void> {
  await store.put(pinKey(pin.repo), new TextEncoder().encode(JSON.stringify(pin, null, 2)), 'application/json');
}

/** Persist an immutable snapshot. Byte-faithful: the same wire shape the route returns (base64 binaries). */
export async function saveSnapshot(
  store: ObjectStore,
  repo: string,
  sha: string,
  files: TemplateFile[],
): Promise<void> {
  await store.put(snapshotKey(repo, sha), new TextEncoder().encode(JSON.stringify(files)), 'application/json');
}

export async function loadSnapshot(store: ObjectStore, repo: string, sha: string): Promise<TemplateFile[] | null> {
  const bytes = await store.get(snapshotKey(repo, sha));

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

export interface SnapshotListing {
  sha: string;
  size: number;
  storedAt?: string;
}

/** Every snapshot still in the store for a repo — the rollback menu. Newest first. */
export async function listSnapshots(store: ObjectStore, repo: string): Promise<SnapshotListing[]> {
  const objects = await store.list(`${SNAPSHOT_PREFIX}/${safeRepo(repo)}/`);

  return objects
    .map((o) => ({
      sha:
        o.key
          .split('/')
          .pop()
          ?.replace(/\.json$/, '') ?? '',
      size: o.size,
      storedAt: o.lastModified,
    }))
    .filter((s) => s.sha.length > 0)
    .sort((a, b) => (b.storedAt ?? '').localeCompare(a.storedAt ?? ''));
}
