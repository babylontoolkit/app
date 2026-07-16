/**
 * GitHub Sync — the pure decision core (SPEC §4.13).
 *
 * §4.13 is deliberately a **sync bridge, not a git client**: exactly one linked repo+branch per
 * project, fast-forward-only, and the platform NEVER merges. Every one of those rules is a decision
 * that can be made without touching the network, so it lives here, tested — and the Octokit adapter
 * (`sync.ts`) is left to do nothing but I/O. The dangerous operations (overwriting the platform on
 * pull, refusing a push that would clobber remote history) are decided by pure functions with
 * exhaustive tests, the same discipline the restore-target selection got (§4.12), because the failure
 * mode is identical: silently destroy the user's work in the wrong direction.
 *
 * Available to ALL users, never gated (§4.13) — Pro adds only BYOK + model choice (§4.6.1). Nothing in
 * this module or its routes consults entitlements.
 */
import type { SerializedFileMap } from '~/lib/binary/binary-files';
import { brand } from '~/config/brand';

export type Divergence =
  | { kind: 'in-sync' } // remote head == last synced: a normal fast-forward push is safe
  | { kind: 'first-push' } // never synced: base the push on the branch head (or create it)
  | { kind: 'diverged'; remoteHead: string }; // remote moved since we last synced: DO NOT auto-overwrite

/**
 * Decide whether a push may proceed as a fast-forward.
 *
 * The rule (§4.13): a push is allowed only if the remote branch head is exactly what we last synced
 * FROM. If the remote moved (someone pushed from their laptop), the platform refuses and hands the
 * user the divergence choice — it never force-pushes over commits it did not make.
 *
 * `remoteHead` is null when the branch does not exist yet (a brand-new repo we are about to create).
 */
export function detectPushDivergence(remoteHead: string | null, lastSyncedCommitSha: string | undefined): Divergence {
  if (!remoteHead) {
    return { kind: 'first-push' };
  }

  if (!lastSyncedCommitSha) {
    /*
     * The repo exists and has commits, but this project has never synced to it. Treat the current head
     * as the base so the push builds ON it rather than replacing it.
     */
    return { kind: 'first-push' };
  }

  if (remoteHead === lastSyncedCommitSha) {
    return { kind: 'in-sync' };
  }

  return { kind: 'diverged', remoteHead };
}

/** A default commit message from the generation summary (§4.13: "AI: add boost pads to RaceMode"). */
export function buildCommitMessage(summary: string | undefined): string {
  const trimmed = summary?.trim();

  if (!trimmed) {
    return `Update from ${brand.productFullName}`;
  }

  // One line, bounded — a commit subject, not an essay. Keep the AI: prefix so history is readable.
  const firstLine = trimmed.split('\n')[0].slice(0, 72);

  return firstLine.startsWith('AI:') ? firstLine : `AI: ${firstLine}`;
}

export interface TreeBlob {
  path: string;

  /** Git blob content. Binary files are base64 (uploaded as `encoding: 'base64'`); text is utf-8. */
  content: string;
  encoding: 'utf-8' | 'base64';
}

/**
 * Turn a snapshot's byte-faithful file map into Git tree blobs.
 *
 * Binary bytes survive because they were base64 in the `SerializedFileMap` and go up as a base64 blob
 * — the same byte-faithfulness rule as snapshots and share builds (spec/binary-files.md). Paths are
 * normalised to repo-relative (the WebContainer workdir prefix stripped), because a repo has no
 * `/home/project`.
 *
 * The `.env` family is EXCLUDED — it is gitignored in the project and must never be pushed (§4.14
 * secrets, §5). This is the push-side counterpart to the publish secret scan.
 */
export function mapToTreeBlobs(files: SerializedFileMap): TreeBlob[] {
  const blobs: TreeBlob[] = [];

  for (const [rawPath, dirent] of Object.entries(files)) {
    if (dirent?.type !== 'file') {
      continue;
    }

    const path = rawPath.replace(/^\/?(home\/project\/)?/, '').replace(/^\/+/, '');

    if (!path || isSecretPath(path)) {
      continue;
    }

    blobs.push({
      path,
      content: dirent.content,
      encoding: dirent.isBinary ? 'base64' : 'utf-8',
    });
  }

  return blobs.sort((a, b) => a.path.localeCompare(b.path));
}

/** Files that must never be pushed to a repo, however the sync is triggered (§4.14, §5). */
export function isSecretPath(path: string): boolean {
  return /(^|\/)\.env$/.test(path) || /(^|\/)\.env\.[^/]*local$/.test(path) || /(^|\/)\.npmrc$/.test(path);
}

/**
 * The divergence resolution the user picked (§4.13). The platform offers exactly two, and NEVER a
 * merge: overwrite the platform from remote (a checkpoint is saved first, §4.12), or push the platform
 * state to a NEW branch the user merges themselves. This validates the choice; the routes execute it.
 */
export type DivergenceChoice = 'pull-overwrite' | 'push-to-new-branch';

export function isValidDivergenceChoice(choice: string): choice is DivergenceChoice {
  return choice === 'pull-overwrite' || choice === 'push-to-new-branch';
}

/** The `platform/<date>` branch name for the "push to a new branch" escape hatch (§4.13). */
export function divergenceBranchName(isoDate: string): string {
  // isoDate passed in (never `new Date()` here — pure). e.g. 2026-07-14T03:00:00Z → platform/2026-07-14
  return `platform/${isoDate.slice(0, 10)}`;
}
