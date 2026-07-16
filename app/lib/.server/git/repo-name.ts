/**
 * Turning a project title into a repository name (SPEC §4.5.4b).
 *
 * Save is one click: the user never types `owner/name`, so this function decides what appears in their
 * GitHub or GitLab account. That makes it worth more care than a slugify usually gets — it is naming a
 * real, permanent thing in someone else's namespace, from text they wrote for a different purpose.
 *
 * The rules are the INTERSECTION of both providers, deliberately, so one derivation works for both and
 * a user switching providers gets the same name:
 *
 *   - GitHub: `[A-Za-z0-9._-]`, may not be `.` or `..`, ≤100 chars.
 *   - GitLab: must START with a letter or digit, may contain `._-`, may not end in `.git` or `.atom`,
 *     and the path is what appears in the URL.
 *
 * So: lowercase, `[a-z0-9-]` only, must start with a letter or digit, no dots at all (which sidesteps
 * `.git`/`.atom`/`..` entirely rather than special-casing them). Dots are the only real loss and no
 * user misses them in a repo name.
 */

/** Both providers allow far more; this is a name a human reads in a URL, not a database key. */
const MAX_LENGTH = 60;

/**
 * The fallback.
 *
 * Reached when a title slugifies to nothing — which is not exotic. "3D レーシング", "🏎️", and "..." all
 * do it, and a user whose game is named in a non-Latin script must still be able to press Save.
 */
export const FALLBACK_REPO_NAME = 'babylon-game';

export function deriveRepoName(projectName: string): string {
  const slug = projectName
    .toLowerCase()

    // Every run of anything we do not allow collapses to ONE hyphen — never a wall of them.
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_LENGTH)

    /*
     * Trim again AFTER slicing. The cut can land mid-separator and leave a trailing hyphen, which
     * GitLab rejects — a validation error on Save for nothing but an unlucky title length.
     */
    .replace(/-+$/g, '');

  // Must start with a letter or digit (GitLab). The slug is already `[a-z0-9-]`, so this is the check.
  if (!/^[a-z0-9]/.test(slug)) {
    return FALLBACK_REPO_NAME;
  }

  return slug;
}

/**
 * The nth name to try.
 *
 * Save never adopts an existing repo (see `EnsureRepoInput.adoptExisting`), so when the derived name
 * is taken it moves along: `my-game`, `my-game-2`, `my-game-3`. Numbering from 2 because `my-game-1`
 * implies a `my-game-0` that does not exist.
 *
 * The base is re-trimmed to fit the suffix rather than letting the result run past the cap — a name
 * the provider then rejects is a Save that fails on attempt 11 for a reason no one can see.
 */
export function candidateRepoName(base: string, attempt: number): string {
  if (attempt === 0) {
    return base;
  }

  const suffix = `-${attempt + 1}`;

  return `${base.slice(0, MAX_LENGTH - suffix.length).replace(/-+$/g, '')}${suffix}`;
}

/**
 * How many names Save tries before giving up.
 *
 * Bounded because each attempt is a real round-trip to the provider, and a user who genuinely has
 * `my-game` through `my-game-11` is better served by an honest message than by a Save that spins.
 */
export const MAX_NAME_ATTEMPTS = 10;
