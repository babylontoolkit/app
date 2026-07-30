/**
 * Git sync — the pure decision core, shared by EVERY provider (SPEC §4.5.4b, §4.13).
 *
 * Moved here from `github/sync-logic.ts` when §4.5.4b promoted the sync bridge to the permanent store:
 * none of these rules were ever GitHub-specific, and leaving them under a `github/` path would have
 * meant `gitlab.ts` importing its own correctness rules from `../github/`, which reads as a mistake
 * even when it isn't. The provider adapters (`github.ts`, `gitlab.ts`) do nothing but I/O.
 *
 * The platform is a **sync bridge, not a git client**: exactly one linked repo+branch per project,
 * fast-forward-only, and the platform NEVER merges. Every one of those is decidable without touching
 * the network, so it lives here, tested. The dangerous operations (overwriting the working copy on
 * pull, refusing a push that would clobber remote history) are pure functions with exhaustive tests —
 * the same discipline `restore-target.ts` got (§4.12), because the failure mode is identical: silently
 * destroy the user's work in the wrong direction.
 *
 * Under §4.5.4b this is load-bearing for SAVING, not just syncing. A bug here does not degrade an
 * optional feature; it loses the only copy of someone's game.
 *
 * Available to ALL users, never gated (§4.13) — Pro adds only BYOK + model choice (§4.6.1). Nothing in
 * this module or its routes consults entitlements.
 */
import { isSecretPath, toRepoRelativePath } from '~/lib/git/paths';
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
export function mapToTreeBlobs(files: SerializedFileMap, onDropped?: (path: string) => void): TreeBlob[] {
  const blobs: TreeBlob[] = [];

  for (const [rawPath, dirent] of Object.entries(files)) {
    if (dirent?.type !== 'file') {
      continue;
    }

    const path = toRepoRelativePath(rawPath);

    if (!path || isSecretPath(path)) {
      continue;
    }

    blobs.push({
      path,
      content: dirent.content,
      encoding: dirent.isBinary ? 'base64' : 'utf-8',
    });
  }

  return dropDirectoryBlobs(blobs, onDropped).sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Drop any blob whose path is also a DIRECTORY in the same push — the one tree git cannot represent.
 *
 * 🔴 **This is the wall that stands between a poisoned file map and a save that silently does
 * nothing** (live 2026-07-30). The CodeSandbox adapter classified newly-created directories as files
 * (`readFileErrorEnvelope` records why), so the map held a "file" at `public/assets` *and* real files
 * at `public/assets/generated/…`. A git tree entry is a blob or a tree, never both, and GitHub refuses
 * the WHOLE request:
 *
 *     422 GitRPC::BadObjectState
 *
 * — which is what the user saw, after the repo had been created and every blob uploaded. Nothing
 * partial lands, so the symptom is the worst possible shape: a repository that exists, is empty, and
 * is now LINKED to the project.
 *
 * The adapter bug is fixed at its source; this exists because the map is not ours alone. It arrives
 * from a browser body, it can be restored from a checkpoint or a working copy written days ago by a
 * different provider, and a repo written from a broken map keeps its damage on every later round trip
 * (the reasoning behind `normalizeRepoFileMap`). One malformed entry must not be able to make Save do
 * nothing forever.
 *
 * **Dropping is provably lossless, which is why it is not a refusal.** A path with children is a
 * directory — that is not a judgement call, and the "file" at that path cannot be a real file the user
 * wrote. Refusing the push instead would trade a corrupt entry for a project that can never be saved
 * at all, and §4.5.4b makes the repo the only permanent copy. The drop is REPORTED (`onDropped`) for
 * the same reason `depositRemixSeed` reports: a best-effort correction that cannot fail the request
 * must still say what it did.
 */
function dropDirectoryBlobs(blobs: TreeBlob[], onDropped?: (path: string) => void): TreeBlob[] {
  const directories = new Set<string>();

  for (const { path } of blobs) {
    const segments = path.split('/');

    // Every ancestor of a blob is a directory, by definition of the path having children.
    for (let i = 1; i < segments.length; i++) {
      directories.add(segments.slice(0, i).join('/'));
    }
  }

  if (directories.size === 0) {
    return blobs;
  }

  return blobs.filter((blob) => {
    if (!directories.has(blob.path)) {
      return true;
    }

    onDropped?.(blob.path);

    return false;
  });
}

/**
 * 🔴 `toRepoRelativePath` and `isSecretPath` MOVED to `~/lib/git/paths.ts` (client-safe) and are
 * re-exported here so every existing server importer keeps working.
 *
 * They moved because the CLIENT needs the identical rules: the restore path (`restore-plan.ts`) must
 * normalise paths exactly as the push did — or it compares `/home/project/src/main.ts` against the
 * repo's `src/main.ts`, concludes every file was deleted, and wipes the project — and it must know
 * that a repo's file map is never authoritative about the `.env` family, or pulling deletes the user's
 * keys. `.server/**` cannot be imported by client code, so the rule moved rather than being copied.
 *
 * Do not reintroduce a local copy. A second copy of "what counts as a secret" is exactly how
 * `.env.production` got pushed.
 */
export { isSecretPath, toRepoRelativePath } from '~/lib/git/paths';

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
