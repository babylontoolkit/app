/**
 * GitHub Sync for one project (SPEC §4.13) — AVAILABLE TO ALL USERS, never gated.
 *
 *   POST /api/projects/:id/github  { op: 'link',   repo, branch }
 *   POST /api/projects/:id/github  { op: 'push',   summary? }
 *   POST /api/projects/:id/github  { op: 'pull' }
 *   POST /api/projects/:id/github  { op: 'resolve', choice, isoDate? }
 *
 * Two walls as always (verified user + owned project). No entitlement check anywhere — Pro adds only
 * BYOK + model choice (§4.6.1); a person's project is never held hostage to the platform (§4.13).
 *
 * The user's GitHub token arrives with the request (their own token, for their own repo) — the same
 * model upstream's connector uses. It is used only to talk to GitHub on their behalf and is never
 * stored server-side or logged. (Hardening to a server-side OAuth App is future work, §4.13.)
 *
 * Push is fast-forward only: if the remote moved, the route returns a `divergence` payload and the
 * client shows the two-button choice (§4.13) — the platform NEVER merges. Pull always checkpoints the
 * current platform state first (§4.12), so any regret is one restore away.
 */
import { json, type ActionFunctionArgs } from '@remix-run/cloudflare';
import { Octokit } from '@octokit/rest';
import { requireVerifiedUser } from '~/lib/.server/supabase/auth';
import { requireOwnedProject } from '~/lib/.server/projects/ownership';
import { getProjectStore, getSnapshotStore } from '~/lib/.server/projects/store';
import { pullFromGitHub, pushToGitHub, pushToNewBranch, parseRepo } from '~/lib/.server/github/sync';
import { isValidDivergenceChoice } from '~/lib/.server/github/sync-logic';
import { errorResponse } from '~/lib/.server/http';

interface Body {
  op: 'link' | 'push' | 'pull' | 'resolve';
  repo?: string;
  branch?: string;
  summary?: string;
  choice?: string;
  isoDate?: string;
  token?: string;
}

/** The user's GitHub token: request body first, then the `git:github.com` cookie upstream sets. */
function readGitHubToken(request: Request, body: Body): string | null {
  if (body.token) {
    return body.token;
  }

  const cookie = request.headers.get('Cookie') ?? '';
  const match = cookie.match(/git:github\.com=([^;]+)/);

  if (match) {
    try {
      const decoded = JSON.parse(decodeURIComponent(match[1]));
      return decoded.username || decoded.password || null;
    } catch {
      return null;
    }
  }

  return null;
}

export async function action({ request, params, context }: ActionFunctionArgs) {
  try {
    const user = await requireVerifiedUser(request, context);
    const project = await requireOwnedProject(user, params.projectId!, context);
    const projects = getProjectStore(context);
    const snapshots = getSnapshotStore(context);
    const body = await request.json<Body>();

    // Linking stores the repo pointer; it needs no token.
    if (body.op === 'link') {
      if (!body.repo || !body.branch) {
        return json({ error: true, message: 'Linking needs a repo (owner/name) and a branch.' }, { status: 400 });
      }

      await projects.update(project.id, {
        linkedRepo: body.repo,
        linkedBranch: body.branch,
        lastSyncedCommitSha: undefined,
      });

      return json({ ok: true, linkedRepo: body.repo, linkedBranch: body.branch });
    }

    if (!project.linkedRepo || !project.linkedBranch) {
      return json({ error: true, message: 'This project is not linked to a repository yet.' }, { status: 409 });
    }

    const token = readGitHubToken(request, body);

    if (!token) {
      return json({ error: true, message: 'Connect your GitHub account first.' }, { status: 401 });
    }

    const octokit = new Octokit({ auth: token });
    const ref = parseRepo(project.linkedRepo, project.linkedBranch);

    if (body.op === 'push') {
      const files = project.currentSnapshotId ? await snapshots.read(project.currentSnapshotId) : null;

      if (!files) {
        return json({ error: true, message: 'There is nothing to push yet — make a change first.' }, { status: 409 });
      }

      const result = await pushToGitHub({
        octokit,
        ref,
        files,
        lastSyncedCommitSha: project.lastSyncedCommitSha,
        summary: body.summary,
      });

      if (!result.ok) {
        // Remote moved. Hand the client the two-button choice — never merge (§4.13).
        return json({ ok: false, divergence: true, remoteHead: result.divergence.remoteHead }, { status: 409 });
      }

      await projects.update(project.id, { lastSyncedCommitSha: result.commitSha });

      return json({ ok: true, commitSha: result.commitSha });
    }

    if (body.op === 'pull') {
      const pulled = await pullFromGitHub({ octokit, ref });

      if (!pulled) {
        return json({ error: true, message: 'The linked branch has no commits to pull.' }, { status: 409 });
      }

      // ALWAYS checkpoint the current state before overlaying the repo (§4.12, §4.13).
      if (project.currentSnapshotId) {
        const current = await snapshots.read(project.currentSnapshotId);

        if (current) {
          await snapshots.create({ projectId: project.id, files: current, label: 'Before GitHub pull' });
        }
      }

      const snapshot = await snapshots.create({
        projectId: project.id,
        files: pulled.files,
        label: 'Pulled from GitHub',
      });
      await projects.update(project.id, { currentSnapshotId: snapshot.id, lastSyncedCommitSha: pulled.head });

      // The client remounts the WebContainer from these files.
      return json({ ok: true, snapshotId: snapshot.id, files: pulled.files, head: pulled.head });
    }

    if (body.op === 'resolve') {
      if (!body.choice || !isValidDivergenceChoice(body.choice)) {
        return json({ error: true, message: 'Choose pull-overwrite or push-to-new-branch.' }, { status: 400 });
      }

      if (body.choice === 'push-to-new-branch') {
        const files = project.currentSnapshotId ? await snapshots.read(project.currentSnapshotId) : null;

        if (!files) {
          return json({ error: true, message: 'Nothing to push.' }, { status: 409 });
        }

        const { branch, commitSha } = await pushToNewBranch({
          octokit,
          ref,
          files,
          isoDate: body.isoDate ?? new Date().toISOString(),
          summary: body.summary,
        });

        return json({ ok: true, branch, commitSha });
      }

      // pull-overwrite: same as a pull (which already checkpoints first).
      const pulled = await pullFromGitHub({ octokit, ref });

      if (!pulled) {
        return json({ error: true, message: 'The linked branch has no commits.' }, { status: 409 });
      }

      if (project.currentSnapshotId) {
        const current = await snapshots.read(project.currentSnapshotId);

        if (current) {
          await snapshots.create({ projectId: project.id, files: current, label: 'Before GitHub overwrite' });
        }
      }

      const snapshot = await snapshots.create({
        projectId: project.id,
        files: pulled.files,
        label: 'Pulled from GitHub',
      });
      await projects.update(project.id, { currentSnapshotId: snapshot.id, lastSyncedCommitSha: pulled.head });

      return json({ ok: true, snapshotId: snapshot.id, files: pulled.files, head: pulled.head });
    }

    return json({ error: true, message: 'Unknown operation.' }, { status: 400 });
  } catch (error) {
    return errorResponse(error);
  }
}
