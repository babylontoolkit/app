/**
 * Git sync for one project (SPEC §4.5.4b, §4.13) — AVAILABLE TO ALL USERS, never gated.
 *
 *   GET  /api/projects/:id/github                             → where it is saved + the repo's head
 *   POST /api/projects/:id/github  { op: 'save',    files, summary? }        → create the repo + push + link
 *   POST /api/projects/:id/github  { op: 'clone',   repo, branch?, provider? } → import a repo's tree
 *   POST /api/projects/:id/github  { op: 'link',    repo, branch, provider? }
 *   POST /api/projects/:id/github  { op: 'push',    files, summary? }
 *   POST /api/projects/:id/github  { op: 'pull' }
 *   POST /api/projects/:id/github  { op: 'resolve', choice, files? }
 *
 * Two walls as always (verified user + owned project). No entitlement check anywhere — Pro adds only
 * BYOK + model choice (§4.6.1); a person's project is never held hostage to the platform (§4.13).
 *
 * ## 🔴 This route is a RELAY, not a store (§4.5.4b)
 *
 * Under repo-primary persistence the user's game lives in THEIR repo and, before they save, only in
 * their browser. The platform keeps the project record, the chat, and the repo pointer — never the
 * code. So `push` takes the files from the request body and hands them straight to the provider, and
 * `pull` hands the provider's answer straight back. Nothing is written to the snapshot store on the
 * way through; the bytes exist here only for the life of the request.
 *
 * This is why `push` carries a body at all. It used to read `project.currentSnapshotId` and pull the
 * files out of OUR object storage — which only worked because we were keeping a full copy of every
 * project, which is the thing §4.5.4b removes. The checkpoint history now lives in the browser
 * (`lib/persistence/local-snapshots.ts`), so the browser is the only place a push can source from.
 *
 * The checkpoint that a pull must take FIRST (§4.12, §4.13) therefore also happens client-side, before
 * the pulled files are applied. The server cannot take it: it has nothing to take a checkpoint OF.
 *
 * ## 🔴 The token no longer comes from the client (§4.5.4b)
 *
 * This route used to read `body.token` — a raw PAT the browser kept in `localStorage` and re-sent in
 * the POST body on every op — with the inherited `git:github.com` connector cookie as a fallback. Both
 * paths are GONE. The credential is resolved server-side from the encrypted per-user store
 * (`git/resolve.ts`), refreshed if needed: under §4.5.4b it is the key to the only permanent copy of
 * the user's game, and one that lives in a browser and crosses the wire on every save is a leak with a
 * retry loop. Pinned by `git/no-client-token.spec.ts`.
 *
 * A missing or lapsed connection surfaces as a typed `auth` error (HTTP 401 + `reconnect: true`), never
 * as a silently skipped save — §4.5.4b: "a lapsed token must never silently drop saves."
 *
 * Push is fast-forward only: if the remote moved, the route returns a `divergence` payload and the
 * client shows the two-button choice (§4.13) — the platform NEVER merges.
 */
import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from '@remix-run/cloudflare';
import { requireVerifiedUser } from '~/lib/.server/supabase/auth';
import { requireOwnedProject } from '~/lib/.server/projects/ownership';
import { getProjectStore } from '~/lib/.server/projects/store';
import { divergenceBranchName, isValidDivergenceChoice } from '~/lib/.server/git/sync-logic';
import { GitProviderError, parseRepo, type GitProvider, type GitProviderId } from '~/lib/.server/git/provider';
import { resolveProvider } from '~/lib/.server/git/resolve';
import { configuredProviders } from '~/lib/.server/git/oauth';
import { saveToNewRepo } from '~/lib/.server/git/save';
import { assertFetchedTreeUsable, cloneRepository, parseCloneTarget } from '~/lib/.server/git/clone';
import { CLONE_RATE_LIMIT, enforceUserRateLimit } from '~/lib/.server/security/user-rate-limit';
import { getOAuthConfig } from '~/lib/.server/git/oauth';
import { errorResponse } from '~/lib/.server/http';
import { createScopedLogger } from '~/utils/logger';
import type { Project } from '~/lib/.server/projects/types';
import type { SerializedFileMap } from '~/lib/binary/binary-files';

const logger = createScopedLogger('git.sync-route');

interface Body {
  op: 'save' | 'clone' | 'link' | 'push' | 'pull' | 'resolve';
  repo?: string;
  branch?: string;
  provider?: string;

  /** The project, from the browser — the only place it exists before it reaches the repo (§4.5.4b). */
  files?: SerializedFileMap;
  summary?: string;
  choice?: string;

  /** `link` only: the commit the caller already holds — see the `link` branch for why it matters. */
  head?: unknown;
}

function parseProviderId(raw: string | undefined): GitProviderId {
  // GitHub remains the default so projects linked before §4.5.4b keep working untouched.
  return raw === 'gitlab' ? 'gitlab' : 'github';
}

/** A full 40-hex git object id, or `undefined` — never a half-trusted string. */
const COMMIT_SHA = /^[0-9a-f]{40}$/;

/**
 * The caller-supplied commit sha, validated at the boundary.
 *
 * This value decides whether a later mount reports a divergence, so a junk string does not merely
 * fail to help — it pins the project to a commit that does not exist and makes EVERY future open
 * diverge, permanently and silently. Refused rather than coerced, for the `parseUserEffort` reason:
 * it arrives in a browser body, and inventing a plausible-looking answer is the costly direction.
 */
function parseCommitSha(raw: unknown): string | undefined {
  if (typeof raw !== 'string') {
    return undefined;
  }

  const sha = raw.trim().toLowerCase();

  return COMMIT_SHA.test(sha) ? sha : undefined;
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

/**
 * The files to push, or a refusal.
 *
 * A push with no files is refused rather than treated as "push an empty project": `fastForwardPush`
 * would faithfully commit the deletion of everything in the repo. Under §4.5.4b that repo is the only
 * permanent copy, so a malformed request must never be able to empty it.
 */
function requireFiles(files: SerializedFileMap | undefined) {
  if (!files || typeof files !== 'object' || Object.keys(files).length === 0) {
    return json({ error: true, message: 'There is nothing to save yet — make a change first.' }, { status: 400 });
  }

  return null;
}

/**
 * Where this project is saved, and where its repo currently is (§4.5.4b).
 *
 *   GET /api/projects/:id/github → { linked, provider?, repo?, branch?, lastSyncedCommitSha?, remoteHead? }
 *
 * The browser calls this when opening a project, and feeds the answer to `selectMountSource` along
 * with its own local state. That function decides what to mount; this only reports facts.
 *
 * 🔴 **`remoteHead` is absent when we could not ask, and that is not the same as `null`.**
 * `null` means the branch genuinely has no commits. Absent means offline, or a lapsed token, or the
 * provider is down — and `selectMountSource` treats the two very differently, because collapsing them
 * would let a reload on a flaky connection read the repo as empty, decide the browser is
 * authoritative, and offer to push over a repo it never managed to read. So a provider failure here
 * is swallowed DELIBERATELY (the one place in this file that swallows anything) and reported as "we
 * do not know" rather than as an error: opening a project must work on a train.
 */
export async function loader({ request, params, context }: LoaderFunctionArgs) {
  try {
    const user = await requireVerifiedUser(request, context);
    const project = await requireOwnedProject(user, params.projectId!, context);

    /*
     * Which providers this deployment can save to (§4.5.4b). The client needs this BEFORE the first
     * save: an unlinked project with more than one configured provider must let the user choose where
     * it lives, rather than silently defaulting to one of them.
     */
    const providers = configuredProviders(context);

    if (!project.linkedRepo || !project.linkedBranch) {
      return json({ linked: false, configuredProviders: providers });
    }

    const base = {
      linked: true,
      provider: project.provider ?? 'github',
      repo: project.linkedRepo,
      branch: project.linkedBranch,
      lastSyncedCommitSha: project.lastSyncedCommitSha,
      autoPush: project.autoPush ?? true,
      configuredProviders: providers,
    };

    try {
      const provider = await resolveProvider(context, user.id, base.provider as GitProviderId);
      const remoteHead = await provider.getBranchHead(parseRepo(project.linkedRepo, project.linkedBranch));

      return json({ ...base, remoteHead });
    } catch (error) {
      // No `remoteHead` key at all — "unknown", never a guess. See the header.
      logger.warn(`Could not read the repo head for project ${project.id}: ${(error as Error).message}`);

      return json({ ...base, unreachable: true });
    }
  } catch (error) {
    return errorResponse(error);
  }
}

export async function action({ request, params, context }: ActionFunctionArgs) {
  try {
    const user = await requireVerifiedUser(request, context);
    const project = await requireOwnedProject(user, params.projectId!, context);
    const projects = getProjectStore(context);
    const body = await request.json<Body>();

    /*
     * CLONE (§4.13) — import an existing repository's tree into this project.
     *
     * It lives HERE, as an op on the project's git route, rather than on a route of its own, and that
     * is a security property rather than tidiness: by the time a clone runs the project already exists
     * (`openImportWorkspace` registers it and takes `PROJECT_CREATE_CREDITS` before any fetch), so
     * BOTH walls apply — verified user AND owned project — instead of the single `requireVerifiedUser`
     * a standalone route would have carried. It also inherits this file's `providerErrorResponse`
     * mapper, without which a `GitProviderError` reaching `errorResponse` would flatten to a generic
     * 500 and the client would lose the `reconnect` signal that drives the connect prompt.
     *
     * Handled BEFORE the linked-repo check below: an import is precisely what a project with no repo
     * does, and the repo being cloned is deliberately NOT the project's own link (there is not one yet
     * — T9 writes it afterwards, as a complete tuple).
     */
    if (body.op === 'clone') {
      if (!body.repo) {
        return json({ error: true, message: 'Enter a repository to import.' }, { status: 400 });
      }

      /*
       * PER-USER (§5, §10 item 20) — not the inherited per-IP limiter, which a single account holder
       * resets by changing network. Counted BEFORE the fetch, so a refused call costs no egress.
       */
      await enforceUserRateLimit({ userId: user.id, bucket: 'git-clone', rule: CLONE_RATE_LIMIT });

      const target = parseCloneTarget(body.repo, {
        gitlabHost: getOAuthConfig(context, 'gitlab')?.host,
        provider: body.provider,
      });

      if (body.branch) {
        target.branch = body.branch;
      }

      try {
        const cloned = await cloneRepository({ context, userId: user.id, target });
        return json({ ok: true, ...cloned });
      } catch (error) {
        if (error instanceof GitProviderError) {
          return providerErrorResponse(error);
        }

        throw error;
      }
    }

    // Linking stores the repo pointer; it needs no provider call.
    if (body.op === 'link') {
      if (!body.repo || !body.branch) {
        return json({ error: true, message: 'Linking needs a repo (owner/name) and a branch.' }, { status: 400 });
      }

      /*
       * All three together — `provider` is not optional here (§4.5.4b, migration 0006's
       * `projects_link_complete_check`). A repo without a provider names no adapter, so the project
       * would read as LINKED while every save silently had nowhere to go.
       */
      const providerId = parseProviderId(body.provider);

      /*
       * 🔴 A CLONE KNOWS WHICH COMMIT IT TOOK, AND NOT RECORDING IT MANUFACTURES A DIVERGENCE.
       *
       * `undefined` is the right answer for a bare link — the user named a repo they had not read, so
       * the platform has never agreed with it about anything. It is the WRONG answer for an import,
       * which just read the tree at a known head, and the difference is not cosmetic:
       * `selectMountSource` computes `remoteMoved = remoteHead !== lastSyncedCommitSha`, so a
       * freshly-cloned project mounts as `diverged` against the very commit it was cloned from
       * (MEASURED live 2026-08-03 in a browser with every store wiped).
       *
       * What that costs is invisible from here and was reported as three unrelated bugs: the user is
       * asked to choose between two byte-identical versions; whichever they pick runs a FULL restore
       * that rewrites every file including `vite.config.ts`; Vite sees its config change and RESTARTS,
       * and a restart clears the terminal — so the `npm install` log and the dev-server banner scroll
       * away and the workspace looks like nothing ever ran. Owner: *"There is no proper npm install and
       * npm run dev."* Correct observation, three layers downstream of its cause.
       *
       * Optional, and validated: the sha arrives in a browser body, and a caller that does not know
       * its head must still be able to link.
       */
      const head = parseCommitSha(body.head);

      if (body.head !== undefined && head === undefined) {
        return json({ error: true, message: 'That is not a commit sha.' }, { status: 400 });
      }

      await projects.update(project.id, {
        provider: providerId,
        linkedRepo: body.repo,
        linkedBranch: body.branch,
        lastSyncedCommitSha: head,
      });

      return json({ ok: true, provider: providerId, linkedRepo: body.repo, linkedBranch: body.branch });
    }

    /*
     * SAVE (§4.5.4b) — the one click that makes a browser-only project permanent.
     *
     * It is its own op rather than "link, then push" because the two must not be separable: a link
     * recorded without a successful push is a project that says "Saved To GitHub" and points at an
     * empty repository. So the record is written only after the bytes land, and a failed Save leaves
     * the project honestly UNLINKED.
     *
     * Handled BEFORE the linked-repo check below, because Save is precisely what a project with no
     * repo does. An already-linked project that presses Save just pushes (`saveExisting`).
     */
    if (body.op === 'save') {
      const refusal = requireFiles(body.files);

      if (refusal) {
        return refusal;
      }

      return await save({ user, project, body, projects, context });
    }

    if (!project.linkedRepo || !project.linkedBranch) {
      return json({ error: true, message: 'This project is not linked to a repository yet.' }, { status: 409 });
    }

    /*
     * The PROJECT decides which provider it is saved to, not the request body. Once linked, the repo
     * and the adapter that can reach it are one fact; letting a caller pass `provider: 'gitlab'` for a
     * GitHub-linked project would resolve the wrong token against the wrong host. The body fallback is
     * only for rows linked before §4.5.4b, which have a repo and no provider column value.
     */
    const providerId = project.provider ?? parseProviderId(body.provider);

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
        const refusal = requireFiles(body.files);

        if (refusal) {
          return refusal;
        }

        const result = await provider.fastForwardPush({
          ref,
          files: body.files!,
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
        return await pull({ provider, ref, projectId: project.id, context });
      }

      if (body.op === 'resolve') {
        if (!body.choice || !isValidDivergenceChoice(body.choice)) {
          return json({ error: true, message: 'Choose pull-overwrite or push-to-new-branch.' }, { status: 400 });
        }

        if (body.choice === 'push-to-new-branch') {
          const refusal = requireFiles(body.files);

          if (refusal) {
            return refusal;
          }

          /*
           * The date is minted HERE, not taken from the body. The old route accepted the client's
           * `isoDate` unvalidated and sliced it into a branch name, letting a caller name the branch
           * anything sliceable. It is our escape hatch; we name it.
           */
          const branch = divergenceBranchName(new Date().toISOString());

          const result = await provider.fastForwardPush({
            ref: { ...ref, branch },
            files: body.files!,

            // A brand-new branch has nothing to diverge from.
            lastSyncedCommitSha: undefined,
            summary: body.summary,
          });

          if (!result.ok) {
            return json({ error: true, message: 'That branch already exists — try again.' }, { status: 409 });
          }

          return json({ ok: true, branch, commitSha: result.commitSha });
        }

        // pull-overwrite: the same read a pull does. The client checkpoints before applying it.
        return await pull({ provider, ref, projectId: project.id, context });
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

/**
 * Save: create the repo if needed, push, and record the link only once the bytes have landed.
 *
 * An already-linked project takes the push path — Save and "push my latest work" are the same verb to
 * a user, and making the button mean two different things would be the surprise, not the convenience.
 * A divergence on that path returns the two-button choice exactly as a manual push does (§4.13).
 */
async function save(input: {
  user: { id: string };
  project: Project;
  body: Body;
  projects: ReturnType<typeof getProjectStore>;
  context: unknown;
}) {
  const { project, body, projects, context } = input;
  const providerId = project.provider ?? parseProviderId(body.provider);

  let provider: GitProvider;

  try {
    provider = await resolveProvider(context, input.user.id, providerId);
  } catch (error) {
    if (error instanceof GitProviderError) {
      return providerErrorResponse(error);
    }

    throw error;
  }

  try {
    // Already saved once: this is a push to the repo they already have.
    if (project.linkedRepo && project.linkedBranch) {
      const result = await provider.fastForwardPush({
        ref: parseRepo(project.linkedRepo, project.linkedBranch),
        files: body.files!,
        lastSyncedCommitSha: project.lastSyncedCommitSha,
        summary: body.summary,
      });

      if (!result.ok) {
        return json({ ok: false, divergence: true, remoteHead: result.divergence.remoteHead }, { status: 409 });
      }

      await projects.update(project.id, { lastSyncedCommitSha: result.commitSha });

      return json({ ok: true, commitSha: result.commitSha, repo: project.linkedRepo, branch: project.linkedBranch });
    }

    const saved = await saveToNewRepo({
      provider,
      projectName: project.name,
      files: body.files!,
      summary: body.summary,
    });

    /*
     * The link is written HERE — after the push, never before. All four fields together, which the
     * database also insists on (`projects_link_complete_check`). Until this line runs the project is
     * UNLINKED, and that is the truthful state: nothing of it exists outside the browser yet.
     */
    await projects.update(project.id, {
      provider: saved.provider,
      linkedRepo: saved.repo,
      linkedBranch: saved.branch,
      lastSyncedCommitSha: saved.commitSha,
    });

    return json({
      ok: true,
      created: saved.created,
      provider: saved.provider,
      repo: saved.repo,
      branch: saved.branch,
      commitSha: saved.commitSha,
    });
  } catch (error) {
    if (error instanceof GitProviderError) {
      return providerErrorResponse(error);
    }

    throw error;
  }
}

/**
 * Read the linked branch and hand the files back.
 *
 * Note what does NOT happen: no snapshot is written. The files pass through this process and into the
 * response. The CLIENT checkpoints its current state before applying them (§4.12) — it has to, because
 * it is the only party that holds the state being replaced.
 *
 * `lastSyncedCommitSha` moves here rather than on the client, because it is the platform's record of
 * what the repo looked like when we last agreed with it, and it is what the next push's
 * fast-forward check is measured against.
 *
 * 🔴 **THIS IS AN INGEST PATH, and it is the one that was not guarded (2026-08-19).** `cloneRepository`
 * refuses an oversize tree and refuses Git-LFS; this read did neither, so both guards were bypassed by
 * the ordinary workflow they were written for — save a small project, add gigabytes of glTF to the
 * repository from a git client, press Sync. See `assertFetchedTreeUsable` for what each refusal
 * prevents. The check lives HERE, in the shared helper, rather than on `op === 'pull'`, because
 * `op: 'resolve' { choice: 'pull-overwrite' }` is a second door onto the same read: guarding a list of
 * the ops someone enumerated is the `coversWorkspace` mistake, and the next door walks past it.
 */
async function pull(input: {
  provider: GitProvider;
  ref: ReturnType<typeof parseRepo>;
  projectId: string;
  context: unknown;
}) {
  const pulled = await input.provider.fetchTree(input.ref);

  if (!pulled) {
    return json({ error: true, message: 'The linked branch has no commits to pull.' }, { status: 409 });
  }

  /*
   * 🔴 BEFORE the sync pointer moves, and that ordering is load-bearing rather than tidy.
   *
   * `lastSyncedCommitSha` records the commit we last AGREED with, and the next push's fast-forward
   * check is measured against it. Stamping it for a tree we then refused would claim agreement with
   * bytes the user never received — so the following push would measure against a commit this project
   * has never held, and fast-forward straight over the work in the repository.
   */
  assertFetchedTreeUsable(pulled.files, { context: input.context, operation: 'sync' });

  await getProjectStore(input.context).update(input.projectId, { lastSyncedCommitSha: pulled.head });

  return json({ ok: true, files: pulled.files, head: pulled.head });
}
