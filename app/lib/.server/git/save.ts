/**
 * Save — the one click that turns a browser-only project into a permanent one (SPEC §4.5.4b).
 *
 * Before Save, a project exists in exactly one browser profile and nowhere else. After Save, it lives
 * in a private repository in the user's own account, and that repository is the only permanent copy —
 * the platform keeps the project record, the chat, and a pointer.
 *
 * The whole flow:
 *
 *   1. derive a repo name from the project title (`repo-name.ts`)
 *   2. create it PRIVATE in the user's account — never adopting a repo that is already there
 *   3. push the files
 *   4. hand back the link so the caller can record provider + repo + branch, together
 *
 * ## What is load-bearing here
 *
 * **Create, never adopt.** `ensureRepo({adoptExisting: false})` is the point of that flag existing. We
 * DERIVED this name from a title; the user never typed it and never approved it. A user with an
 * unrelated `my-game` repo would otherwise have had it adopted and its HEAD replaced by this project —
 * silently, since a project that has never synced pushes as `first-push` and builds on whatever head
 * it finds. On a name collision Save moves to the next name instead.
 *
 * **The repo is created BEFORE the push, and that ordering can leave a mess.** If the push fails —
 * network, rate limit, a huge project — the repo exists and is empty. That is deliberate: the
 * alternative is deleting a repository we just created in someone's account on an error path, which
 * is a far worse thing to get wrong. An empty repo is visible, harmless, and reused by the retry
 * (`resumeSave`), because the next attempt finds it linked and simply pushes again.
 *
 * **Nothing is recorded until the push lands.** The caller writes the link only on success, so a
 * failed Save leaves the project UNLINKED — honestly telling the user it is not saved, which it is
 * not. A link written first would show "Saved to GitHub" over an empty repository.
 */
import type { SerializedFileMap } from '~/lib/binary/binary-files';
import { GitProviderError, parseRepo, type GitProvider, type GitProviderId } from './provider';
import { MAX_NAME_ATTEMPTS, candidateRepoName, deriveRepoName } from './repo-name';
import { brand } from '~/config/brand';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('git.save');

export interface SaveResult {
  provider: GitProviderId;

  /** `owner/repo` as the provider named it. */
  repo: string;
  branch: string;
  commitSha: string;

  /** True when Save created the repository (as opposed to pushing to one it already linked). */
  created: boolean;
}

export interface SaveInput {
  provider: GitProvider;
  projectName: string;
  files: SerializedFileMap;
  summary?: string;
}

/**
 * Create the user's repo and push their project into it.
 *
 * Throws `GitProviderError` — `auth` for a lapsed connection (the UI re-connects), `rate-limit` and
 * `unavailable` as retryable, everything else terminal. §4.5.4b: a failed save is LOUD; nothing here
 * catches and shrugs.
 */
export async function saveToNewRepo(input: SaveInput): Promise<SaveResult> {
  const base = deriveRepoName(input.projectName);
  const repo = await createRepoWithFreeName(input.provider, base, input.projectName);
  const ref = parseRepo(repo.fullName, repo.defaultBranch);

  const push = await input.provider.fastForwardPush({
    ref,
    files: input.files,

    // A repo we just created has no history to diverge from.
    lastSyncedCommitSha: undefined,
    summary: input.summary,
  });

  if (!push.ok) {
    /*
     * Unreachable in practice — we created this repo microseconds ago, so nothing can have moved its
     * head. It is handled rather than asserted because "unreachable" and "impossible" differ: a name
     * race with the user's own second tab could produce it, and a thrown error is a truthful failure
     * where a `!` would be a crash.
     */
    throw new GitProviderError({
      kind: 'invalid',
      message: 'That repository changed while we were saving. Try again.',
    });
  }

  logger.info(`Saved project to ${repo.fullName}@${repo.defaultBranch} → ${push.commitSha}`);

  return {
    provider: input.provider.id,
    repo: repo.fullName,
    branch: repo.defaultBranch,
    commitSha: push.commitSha,
    created: repo.created,
  };
}

/**
 * Find a name the user does not already have, and create it.
 *
 * Every `name-taken` is a retry with the next candidate; every other failure is real and propagates
 * immediately. Distinguishing those two is exactly why `name-taken` is its own error kind — both are
 * 4xx from the provider, and treating a permission error as "try another name" would burn ten
 * round-trips before reporting the wrong cause.
 */
async function createRepoWithFreeName(provider: GitProvider, base: string, projectName: string) {
  for (let attempt = 0; attempt < MAX_NAME_ATTEMPTS; attempt++) {
    const name = candidateRepoName(base, attempt);

    try {
      return await provider.ensureRepo({
        name,
        private: true,
        description: `${projectName} — built with ${brand.productName}`,

        // 🔴 Never adopt. See this file's header.
        adoptExisting: false,
      });
    } catch (error) {
      if (error instanceof GitProviderError && error.kind === 'name-taken') {
        continue;
      }

      throw error;
    }
  }

  throw new GitProviderError({
    kind: 'invalid',
    message: `You already have repositories named ${base} through ${candidateRepoName(base, MAX_NAME_ATTEMPTS - 1)}. Rename this project and try again.`,
  });
}
