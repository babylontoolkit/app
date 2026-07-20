/**
 * Template mount endpoint (SPEC §4.4).
 *
 *   GET /api/github-template?repo=owner/repo[&fallback=1]  → TemplateFile[]
 *
 * The fetching itself lives in `templates/fetch.ts`; the decision of WHAT to serve lives in
 * `templates/pin.ts`. This route is the wiring between them, and its response header
 * (`X-Template-Source: pinned | live | last-known-good`) is how anyone answers "which bytes did this
 * project actually get".
 *
 * The default is now the PINNED snapshot, not live `main` (§4.4 pin-and-cache): a snapshot is fetched
 * once, stored under its commit SHA, and served from storage until an admin deliberately promotes a
 * newer one. Creation therefore has no runtime GitHub dependency, and a bad push to `main` cannot reach
 * users without someone choosing it.
 *
 * ⚠️ **Verified callers only** (SPEC §5, `spec/spend-holes.md`). `repo` is caller-chosen and the live
 * path spends on the PLATFORM GitHub token and writes up to three objects to our storage per request —
 * so anonymously it was an unbounded zipball-download + S3-write loop on the owner's bill. Its one
 * caller is project creation, which already requires an account.
 */
import { json } from '@remix-run/cloudflare';
import { denyUnlessVerified } from '~/lib/.server/http';
import { getObjectStore } from '~/lib/.server/storage';
import { getPlatformConfig } from '~/lib/.server/agent/config';
import { isTemplatePinningEnabled } from '~/lib/.server/templates/config';
import { fetchTemplateFiles, resolveGitHubToken, resolveTemplateRef } from '~/lib/.server/templates/fetch';
import { loadLastKnownGood, saveLastKnownGood, validateTemplateFiles } from '~/lib/.server/templates/last-known-good';
import { decideTemplateSource, loadSnapshot, readPin, saveSnapshot, writePin } from '~/lib/.server/templates/pin';

export async function loader({ request, context }: { request: Request; context: any }) {
  const denied = await denyUnlessVerified(request, context);

  if (denied) {
    return denied;
  }

  const url = new URL(request.url);
  const repo = url.searchParams.get('repo');

  /**
   * `?fallback=1` — the client detected a broken mount and is asking for the last-known-good snapshot
   * instead. The server cannot see a runtime-broken WebContainer, so this is the only signal that bytes
   * which pass every structural check still do not work (SPEC §4.4).
   */
  const preferFallback = url.searchParams.get('fallback') === '1';

  if (!repo) {
    return json({ error: 'Repository name is required' }, { status: 400 });
  }

  const store = getObjectStore(context);
  const pinningEnabled = isTemplatePinningEnabled(context);
  const pin = pinningEnabled ? await readPin(store, repo) : null;

  /*
   * Resolve the pin BEFORE deciding: a pin whose snapshot has been deleted out from under it is not a
   * pin, and the decision core must be told that rather than discover it later.
   */
  const pinnedFiles = pin ? await loadSnapshot(store, repo, pin.sha) : null;

  const source = decideTemplateSource({
    pin,
    pinnedSnapshotExists: Boolean(pinnedFiles),
    preferFallback,
    pinningEnabled,
  });

  if (source.kind === 'pinned' && pinnedFiles) {
    return json(pinnedFiles, {
      headers: { 'X-Template-Source': 'pinned', 'X-Template-Sha': source.sha },
    });
  }

  if (source.kind === 'last-known-good') {
    const cached = await loadLastKnownGood(store, repo);

    if (cached) {
      console.warn(`Serving last-known-good template for ${repo} at client request (broken mount).`);
      return json(cached, { headers: { 'X-Template-Source': 'last-known-good' } });
    }

    // No snapshot to fall back to — fall through to a live fetch below rather than fail creation.
  }

  try {
    const githubToken = resolveGitHubToken(
      getPlatformConfig(context).githubToken || process.env.GITHUB_TOKEN || process.env.VITE_GITHUB_ACCESS_TOKEN,
    );

    const resolved = await resolveTemplateRef(repo, undefined, githubToken);
    const files = await fetchTemplateFiles(repo, resolved.sha, { githubToken, context });

    /**
     * A fetch can "succeed" (HTTP 200) yet return something that will NOT mount — an empty/truncated
     * zip, or a missing vendored framework when submodule resolution fails. Treat that exactly like a
     * failed fetch: serve the last-known-good snapshot rather than mounting a dead project.
     */
    const check = validateTemplateFiles(files);

    if (!check.ok) {
      const cached = await loadLastKnownGood(store, repo);

      if (cached) {
        console.warn(`Live template for ${repo} was unmountable (${check.reason}); serving last-known-good.`);
        return json(cached, { headers: { 'X-Template-Source': 'last-known-good' } });
      }

      throw new Error(`Template fetch produced an unmountable result (${check.reason}) and no snapshot exists.`);
    }

    /*
     * Persist. Both writes are best-effort: a store error must never fail an otherwise-good creation —
     * the user gets their project, and the next request simply fetches live again.
     */
    try {
      await saveLastKnownGood(store, repo, files);

      if (source.kind === 'live' && source.pinAfter) {
        /*
         * Bootstrap the pin (§4.4). From here on this repo mounts from storage until someone promotes,
         * so live `main` stops being able to reach users unreviewed. `pinnedBy: 'auto'` marks it as the
         * one pin nobody chose — an admin can see it was never actually reviewed.
         */
        await saveSnapshot(store, repo, resolved.sha, files);
        await writePin(store, {
          repo,
          sha: resolved.sha,
          ref: resolved.ref,
          pinnedAt: new Date().toISOString(),
          pinnedBy: 'auto',
          fileCount: files.length,
        });
        console.warn(`Pinned ${repo} to ${resolved.sha.slice(0, 8)} (${resolved.ref}) — first fetch.`);
      }
    } catch (storeError) {
      console.warn(`Failed to persist template snapshot for ${repo}:`, storeError);
    }

    return json(files, {
      headers: { 'X-Template-Source': 'live', 'X-Template-Sha': resolved.sha },
    });
  } catch (error) {
    console.error('Error processing GitHub template:', error);
    console.error('Repository:', repo);
    console.error('Error details:', error instanceof Error ? error.message : String(error));

    // Live fetch failed outright — serve the last-known-good snapshot instead of failing creation.
    const cached = await loadLastKnownGood(store, repo);

    if (cached) {
      console.warn(`Live template fetch for ${repo} failed; serving last-known-good snapshot.`);
      return json(cached, { headers: { 'X-Template-Source': 'last-known-good' } });
    }

    return json(
      {
        error: 'Failed to fetch template files',
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  }
}
