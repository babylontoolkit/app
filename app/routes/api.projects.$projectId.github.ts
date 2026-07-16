/**
 * Git sync for one project (SPEC §4.5.4b, §4.13) — AVAILABLE TO ALL USERS, never gated.
 *
 *   POST /api/projects/:id/github  { op: 'link',    repo, branch, provider? }
 *   POST /api/projects/:id/github  { op: 'push',    summary? }
 *   POST /api/projects/:id/github  { op: 'pull' }
 *   POST /api/projects/:id/github  { op: 'resolve', choice, isoDate? }
 *
 * Two walls as always (verified user + owned project). No entitlement check anywhere — Pro adds only
 * BYOK + model choice (§4.6.1); a person's project is never held hostage to the platform (§4.13).
 *
 * ## 🔴 The token no longer comes from the client (§4.5.4b)
 *
 * This route used to read `body.token` — a raw PAT the browser kept in `localStorage` and re-sent in
 * the POST body on every op — with the inherited `git:github.com` connector cookie as a fallback. Both
 * paths are GONE. The token is resolved server-side from the encrypted per-user store
 * (`git/resolve.ts`), refreshed if needed, and a `token` field in the body is now ignored: under
 * §4.5.4b this credential is the key to the only permanent copy of the user's game, and one that lives
 * in a browser and crosses the wire on every save is a leak with a retry loop.
 *
 * A missing or lapsed connection surfaces as a typed `auth` error (HTTP 401 + `reconnect: true`), never
 * as a silently skipped save — §4.5.4b: "a lapsed token must never silently drop saves."
 *
 * Push is fast-forward only: if the remote moved, the route returns a `divergence` payload and the
 * client shows the two-button choice (§4.13) — the platform NEVER merges. Pull always checkpoints the
 * current platform state first (§4.12), so any regret is one restore away.
 */
import { json, type ActionFunctionArgs } from '@remix-run/cloudflare';
import { requireVerifiedUser } from '~/lib/.server/supabase/auth';
import { requireOwnedProject } from '~/lib/.server/projects/ownership';
import { getProjectStore, getSnapshotStore } from '~/lib/.server/projects/store';
import { divergenceBranchName, isValidDivergenceChoice } from '~/lib/.server/git/sync-logic';
import { GitProviderError, parseRepo, type GitProvider, type GitProviderId } from '~/lib/.server/git/provider';
import { resolveProvider } from '~/lib/.server/git/resolve';
import { errorResponse } from '~/lib/.server/http';

interface Body {
  op: 'link' | 'push' | 'pull' | 'resolve';
  repo?: string;
  branch?: string;
  provider?: string;
  summary?: string;
  choice?: string;
  isoDate?: string;
}

function parseProviderId(raw: string | undefined): GitProviderId {
  // GitHub remains the default so projects linked before §4.5.4b keep working untouched.
  return raw === 'gitlab' ? 'gitlab' : 'github';
}

/** A provider failure becomes an HTTP shape the client can act on — `reconnect` drives the re-auth UI. */
function providerErrorResponse(error: GitProviderError) {
  const status =
    error.kind === 'auth' ? 401 : error.kind === 'not-found' ? 404 : error.kind === 'forbidden' ? 403 : 409;

  return json(
    {
      error: true,
      message: error.message,
      kind: error.kind,
      retryable: error.retryable,
      reconnect: error.kind === 'auth',
    },
    { status },
  );
}

/** Pull + overwrite, checkpointing first. Shared by `pull` and the `pull-overwrite` divergence choice. */
async function pullAndOverlay(input: {
  provider: GitProvider;
  ref: ReturnType<typeof parseRepo>;
  projectId: string;
  currentSnapshotId: string | undefined;
  checkpointLabel: string;
  context: unknown;
}) {
  const snapshots = getSnapshotStore(input.context);
  const projects = getProjectStore(input.context);
  const pulled = await input.provider.fetchTree(input.ref);

  if (!pulled) {
    return json({ error: true, message: 'The linked branch has no commits to pull.' }, { status: 409 });
  }

  // ALWAYS checkpoint the current state before overlaying the repo (§4.12, §4.13).
  if (input.currentSnapshotId) {
    const current = await snapshots.read(input.currentSnapshotId);

    if (current) {
      await snapshots.create({ projectId: input.projectId, files: current, label: input.checkpointLabel });
    }
  }

  const snapshot = await snapshots.create({
    projectId: input.projectId,
    files: pulled.files,
    label: 'Pulled from repo',
  });
  await projects.update(input.projectId, { currentSnapshotId: snapshot.id, lastSyncedCommitSha: pulled.head });

  // The client remounts the WebContainer from these files.
  return json({ ok: true, snapshotId: snapshot.id, files: pulled.files, head: pulled.head });
}

export async function action({ request, params, context }: ActionFunctionArgs) {
  try {
    const user = await requireVerifiedUser(request, context);
    const project = await requireOwnedProject(user, params.projectId!, context);
    const projects = getProjectStore(context);
    const snapshots = getSnapshotStore(context);
    const body = await request.json<Body>();

    // Linking stores the repo pointer; it needs no provider call.
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

    const providerId = parseProviderId(body.provider);

    let provider: GitProvider;

    try {
      // Throws a typed `auth` error when the user has not connected, or their token lapsed.
      provider = await resolveProvider(context, user.id, providerId);
    } catch (error) {
      if (error instanceof GitProviderError) {
        return providerErrorResponse(error);
      }

      throw error;
    }

    const ref = parseRepo(project.linkedRepo, project.linkedBranch);

    try {
      if (body.op === 'push') {
        const files = project.currentSnapshotId ? await snapshots.read(project.currentSnapshotId) : null;

        if (!files) {
          return json({ error: true, message: 'There is nothing to push yet — make a change first.' }, { status: 409 });
        }

        const result = await provider.fastForwardPush({
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
        return await pullAndOverlay({
          provider,
          ref,
          projectId: project.id,
          currentSnapshotId: project.currentSnapshotId,
          checkpointLabel: 'Before repo pull',
          context,
        });
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

          /*
           * The date is minted HERE, not taken from `body.isoDate`. The old route accepted the client's
           * value unvalidated and sliced it into a branch name, letting a caller name the branch
           * anything sliceable. It is our escape hatch; we name it.
           */
          const branch = divergenceBranchName(new Date().toISOString());

          const result = await provider.fastForwardPush({
            ref: { ...ref, branch },
            files,

            // A brand-new branch has nothing to diverge from.
            lastSyncedCommitSha: undefined,
            summary: body.summary,
          });

          if (!result.ok) {
            return json({ error: true, message: 'That branch already exists — try again.' }, { status: 409 });
          }

          return json({ ok: true, branch, commitSha: result.commitSha });
        }

        // pull-overwrite: same as a pull (which already checkpoints first).
        return await pullAndOverlay({
          provider,
          ref,
          projectId: project.id,
          currentSnapshotId: project.currentSnapshotId,
          checkpointLabel: 'Before repo overwrite',
          context,
        });
      }

      return json({ error: true, message: 'Unknown operation.' }, { status: 400 });
    } catch (error) {
      if (error instanceof GitProviderError) {
        return providerErrorResponse(error);
      }

      throw error;
    }
  } catch (error) {
    return errorResponse(error);
  }
}
