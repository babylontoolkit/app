/**
 * GitHub Sync — the Git Data API adapter (SPEC §4.13).
 *
 * Server-side push/pull built from the current snapshot's file manifest via the GitHub Git Data API
 * (trees/commits/refs). **No git binary anywhere, and WebContainers never run git** (§4.13): the whole
 * exchange is REST calls to GitHub. All the decisions (fast-forward-only, secret exclusion, tree
 * building) are made by the pure core in `sync-logic.ts`; this file is only I/O.
 *
 * Availability: ALL users, never gated (§4.13). Sync operations involve no LLM and cost no credits.
 */
import { Octokit } from '@octokit/rest';
import type { SerializedFileMap } from '~/lib/binary/binary-files';
import {
  buildCommitMessage,
  detectPushDivergence,
  divergenceBranchName,
  mapToTreeBlobs,
  type Divergence,
} from './sync-logic';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('github.sync');

export interface RepoRef {
  owner: string;
  repo: string;
  branch: string;
}

/** Split "owner/repo" into its parts. */
export function parseRepo(linkedRepo: string, branch: string): RepoRef {
  const [owner, repo] = linkedRepo.split('/');

  if (!owner || !repo) {
    throw new Error(`Invalid repo "${linkedRepo}" — expected "owner/repo".`);
  }

  return { owner, repo, branch };
}

async function getBranchHead(octokit: Octokit, ref: RepoRef): Promise<string | null> {
  try {
    const { data } = await octokit.git.getRef({ owner: ref.owner, repo: ref.repo, ref: `heads/${ref.branch}` });

    return data.object.sha;
  } catch (error) {
    if ((error as { status?: number }).status === 404) {
      return null;
    }

    throw error;
  }
}

export type PushResult =
  | { ok: true; commitSha: string; head: string }
  | { ok: false; divergence: Extract<Divergence, { kind: 'diverged' }> };

/**
 * Push the current project files to the linked repo+branch, fast-forward only.
 *
 * Refuses (returns `{ ok: false, divergence }`) rather than force-pushing when the remote has moved
 * since our last sync — the route turns that into the two-button divergence choice (§4.13). On success
 * the caller persists the new commit sha as `lastSyncedCommitSha`.
 */
export async function pushToGitHub(input: {
  octokit: Octokit;
  ref: RepoRef;
  files: SerializedFileMap;
  lastSyncedCommitSha?: string;
  summary?: string;
}): Promise<PushResult> {
  const { octokit, ref, files } = input;
  const remoteHead = await getBranchHead(octokit, ref);
  const divergence = detectPushDivergence(remoteHead, input.lastSyncedCommitSha);

  if (divergence.kind === 'diverged') {
    logger.info(`Push refused for ${ref.owner}/${ref.repo}@${ref.branch}: remote moved (divergence).`);
    return { ok: false, divergence };
  }

  // Upload every file as a blob (binaries base64, text utf-8 — byte-faithful).
  const blobs = mapToTreeBlobs(files);
  const tree = await Promise.all(
    blobs.map(async (blob) => {
      const { data } = await octokit.git.createBlob({
        owner: ref.owner,
        repo: ref.repo,
        content: blob.content,
        encoding: blob.encoding,
      });

      return { path: blob.path, mode: '100644' as const, type: 'blob' as const, sha: data.sha };
    }),
  );

  const { data: createdTree } = await octokit.git.createTree({ owner: ref.owner, repo: ref.repo, tree });

  const { data: commit } = await octokit.git.createCommit({
    owner: ref.owner,
    repo: ref.repo,
    message: buildCommitMessage(input.summary),
    tree: createdTree.sha,
    parents: remoteHead ? [remoteHead] : [],
  });

  if (remoteHead) {
    await octokit.git.updateRef({
      owner: ref.owner,
      repo: ref.repo,
      ref: `heads/${ref.branch}`,
      sha: commit.sha,
      force: false, // fast-forward only — never clobber remote history (§4.13)
    });
  } else {
    await octokit.git.createRef({
      owner: ref.owner,
      repo: ref.repo,
      ref: `refs/heads/${ref.branch}`,
      sha: commit.sha,
    });
  }

  logger.info(`Pushed ${blobs.length} files to ${ref.owner}/${ref.repo}@${ref.branch} → ${commit.sha}`);

  return { ok: true, commitSha: commit.sha, head: commit.sha };
}

/**
 * Push the platform state to a NEW branch — the divergence escape hatch (§4.13).
 *
 * The user resolves the merge in their own git tooling; the platform just parks its state on
 * `platform/<date>` so nothing is lost. Never touches the linked branch.
 */
export async function pushToNewBranch(input: {
  octokit: Octokit;
  ref: RepoRef;
  files: SerializedFileMap;
  isoDate: string;
  summary?: string;
}): Promise<{ branch: string; commitSha: string }> {
  const branch = divergenceBranchName(input.isoDate);
  const base = await getBranchHead(input.octokit, input.ref);

  const result = await pushToGitHub({
    octokit: input.octokit,
    ref: { ...input.ref, branch },
    files: input.files,
    lastSyncedCommitSha: undefined, // a brand-new branch has nothing to diverge from
    summary: input.summary,
  });

  if (!result.ok) {
    // A fresh branch cannot diverge; if it somehow does, surface it rather than silently swallow.
    throw new Error('Unexpected divergence pushing to a new branch.');
  }

  void base;

  return { branch, commitSha: result.commitSha };
}

/**
 * Pull the linked branch head into a byte-faithful file map (§4.13).
 *
 * The caller checkpoints the current platform state FIRST (§4.12), then overlays this. Returns the map
 * plus the head sha to persist as the new `lastSyncedCommitSha`.
 */
export async function pullFromGitHub(input: {
  octokit: Octokit;
  ref: RepoRef;
}): Promise<{ files: SerializedFileMap; head: string } | null> {
  const { octokit, ref } = input;
  const head = await getBranchHead(octokit, ref);

  if (!head) {
    return null;
  }

  const { data: commit } = await octokit.git.getCommit({ owner: ref.owner, repo: ref.repo, commit_sha: head });
  const { data: tree } = await octokit.git.getTree({
    owner: ref.owner,
    repo: ref.repo,
    tree_sha: commit.tree.sha,
    recursive: 'true',
  });

  const files: SerializedFileMap = {};

  for (const entry of tree.tree) {
    if (entry.type !== 'blob' || !entry.path || !entry.sha) {
      continue;
    }

    const { data: blob } = await octokit.git.getBlob({ owner: ref.owner, repo: ref.repo, file_sha: entry.sha });
    const isBinary = blob.encoding === 'base64' && !isProbablyText(blob.content, entry.path);

    files[entry.path] = {
      type: 'file',
      isBinary,
      content: isBinary ? blob.content.replace(/\n/g, '') : Buffer.from(blob.content, 'base64').toString('utf-8'),
    };
  }

  logger.info(`Pulled ${Object.keys(files).length} files from ${ref.owner}/${ref.repo}@${ref.branch} @ ${head}`);

  return { files, head };
}

/** Text vs binary by extension — GitHub returns everything base64, so we decide how to decode. */
function isProbablyText(_content: string, path: string): boolean {
  return /\.(ts|tsx|js|jsx|json|md|txt|css|scss|html|svg|glsl|env|gitignore|mjs|cjs|yml|yaml)$/i.test(path);
}
