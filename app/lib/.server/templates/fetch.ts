/**
 * Fetching a template repo's files from GitHub (SPEC §4.4).
 *
 * Lifted out of `api.github-template.ts` (which is now just the loader) because pinning needs the SAME
 * fetch from two places: the bootstrap path, and an admin PROMOTION that fetches a specific ref. The
 * behaviour is unchanged — the binary handling, submodule vendoring and token hygiene below are all
 * load-bearing fixes with their own history (§4.4, spec/binary-files.md).
 *
 * The one addition is `ref`: every fetch now targets an explicit commit SHA rather than "whatever the
 * default branch says right now". That is what makes a snapshot reproducible, and therefore pinnable.
 */
import JSZip from 'jszip';
import { base64ToBytes, isBinaryPath } from '~/lib/binary/binary-files';
import { withGitHubApiVersion } from '~/lib/.server/github-api-version';
import type { TemplateFile } from '~/types/template';

const GITHUB_API = 'https://api.github.com';

/**
 * Submodule URLs for templates whose `.gitmodules` does not resolve (config, not code —
 * keyed by `<owner/repo>#<submodule path>`).
 *
 * Empty by design: our starter now vendors the React Framework directly at `src/babylon`.
 * This exists so a template that DOES use a submodule with a missing/empty `.gitmodules`
 * can still be mounted without a code change (SPEC §4.4).
 */
const SUBMODULE_FALLBACKS: Record<string, string> = {};

/**
 * Treat an unset or placeholder token as NO token.
 *
 * Public templates (our starter included) are fetchable unauthenticated. A stock
 * `.env.example` value like `your_github_token_here` was being sent as a real Bearer,
 * turning a working anonymous fetch into a hard 401 — a missing credential must degrade
 * gracefully, never break a path that works without it (SPEC §1.3 principle 0).
 */
export function resolveGitHubToken(token?: string): string | undefined {
  const trimmed = token?.trim();

  if (!trimmed || /^(your_|<|\$\{|xxx|changeme|placeholder)/i.test(trimmed)) {
    return undefined;
  }

  return trimmed;
}

function headers(githubToken?: string): Record<string, string> {
  /*
   * The version pin (`github-api-version.ts`) — an unversioned call rides a dated default that 410s
   * after its sunset, and this is the path a new project is created on.
   */
  return withGitHubApiVersion({
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'bolt.diy-app',
    ...(githubToken ? { Authorization: `Bearer ${githubToken}` } : {}),
  });
}

export interface ResolvedRef {
  /** The exact commit. Everything downstream — zipball, tree, snapshot key — uses this, never a branch name. */
  sha: string;

  /** Human-readable provenance: `main`, `release:v1.2.0`. Recorded on the pin so a promotion is auditable. */
  ref: string;
}

/**
 * Resolve what to fetch into a concrete commit SHA.
 *
 * `ref` may be a tag, branch, or SHA. When omitted we resolve the repo's DEFAULT BRANCH — deliberately,
 * not `releases/latest`. Upstream preferred `releases/latest` and only fell back to `main` on a 404,
 * which is the §4.4 release-lock footgun: publishing any GitHub Release on AppTemplate silently flipped
 * every new project onto it and froze out `main`. Under pinning nothing ships without a promotion
 * anyway, so the default stays boring and predictable, and a release is promoted BY NAME when wanted.
 */
export async function resolveTemplateRef(repo: string, ref?: string, githubToken?: string): Promise<ResolvedRef> {
  if (ref) {
    const response = await fetch(`${GITHUB_API}/repos/${repo}/commits/${encodeURIComponent(ref)}`, {
      headers: headers(githubToken),
    });

    if (!response.ok) {
      throw new Error(`Cannot resolve ref "${ref}" in ${repo}: ${response.status} ${response.statusText}`);
    }

    return { sha: ((await response.json()) as any).sha, ref };
  }

  const repoResponse = await fetch(`${GITHUB_API}/repos/${repo}`, { headers: headers(githubToken) });

  if (!repoResponse.ok) {
    throw new Error(`Repository not found: ${repo} (${repoResponse.status})`);
  }

  const defaultBranch = ((await repoResponse.json()) as any).default_branch || 'main';
  const headResponse = await fetch(`${GITHUB_API}/repos/${repo}/commits/${defaultBranch}`, {
    headers: headers(githubToken),
  });

  if (!headResponse.ok) {
    throw new Error(`Cannot resolve ${repo}@${defaultBranch}: ${headResponse.status}`);
  }

  return { sha: ((await headResponse.json()) as any).sha, ref: defaultBranch };
}

/** True when running on Cloudflare Pages, where the zipball path is unavailable. */
export function isCloudflareEnvironment(context: any): boolean {
  const isProduction = process.env.NODE_ENV === 'production';
  const hasCfPagesVars = !!(
    context?.cloudflare?.env?.CF_PAGES ||
    context?.cloudflare?.env?.CF_PAGES_URL ||
    context?.cloudflare?.env?.CF_PAGES_COMMIT_SHA
  );

  return isProduction && hasCfPagesVars;
}

/** Fetch a template's files at an exact commit, by whichever method this environment supports. */
export async function fetchTemplateFiles(
  repo: string,
  sha: string,
  options: { githubToken?: string; context?: any } = {},
): Promise<TemplateFile[]> {
  const files = isCloudflareEnvironment(options.context)
    ? await fetchRepoContentsCloudflare(repo, sha, options.githubToken)
    : await fetchRepoContentsZip(repo, sha, options.githubToken);

  return files.filter((file) => !file.path.startsWith('.git'));
}

/** Cloudflare-compatible method using the GitHub Contents API. */
async function fetchRepoContentsCloudflare(repo: string, sha: string, githubToken?: string): Promise<TemplateFile[]> {
  const treeResponse = await fetch(`${GITHUB_API}/repos/${repo}/git/trees/${sha}?recursive=1`, {
    headers: headers(githubToken),
  });

  if (!treeResponse.ok) {
    throw new Error(`Failed to fetch repository tree: ${treeResponse.status}`);
  }

  const treeData = (await treeResponse.json()) as any;

  const files = treeData.tree.filter((item: any) => {
    if (item.type !== 'blob' || item.path.startsWith('.git/')) {
      return false;
    }

    // Allow lock files even if they're large.
    const isLockFile =
      item.path.endsWith('package-lock.json') ||
      item.path.endsWith('yarn.lock') ||
      item.path.endsWith('pnpm-lock.yaml');

    /**
     * Binary game assets are routinely larger than the old 100KB text cap — dropping them
     * silently produced a project with unresolvable asset imports. They are what the game
     * IS (SPEC §1.3 principle 10), so they are kept up to the Contents API's own 1MB limit,
     * above which the API returns no inline content anyway.
     */
    if (isBinaryPath(item.path)) {
      return item.size < 1000000;
    }

    if (!isLockFile && item.size >= 100000) {
      return false;
    }

    return true;
  });

  // Fetch file contents in batches to avoid overwhelming the API.
  const batchSize = 10;
  const fileContents: TemplateFile[] = [];

  for (let i = 0; i < files.length; i += batchSize) {
    const batch = files.slice(i, i + batchSize);
    const batchPromises = batch.map(async (file: any) => {
      try {
        // `?ref=<sha>` pins the content read to the same commit the tree came from.
        const contentResponse = await fetch(`${GITHUB_API}/repos/${repo}/contents/${file.path}?ref=${sha}`, {
          headers: headers(githubToken),
        });

        if (!contentResponse.ok) {
          console.warn(`Failed to fetch ${file.path}: ${contentResponse.status}`);
          return null;
        }

        const contentData = (await contentResponse.json()) as any;
        const base64 = (contentData.content ?? '').replace(/\s/g, '');
        const isBinary = isBinaryPath(file.path);

        /**
         * The Contents API already hands us base64 — for binaries we keep it exactly as
         * it is. Upstream ran it through `atob()`, producing a latin-1 "binary string"
         * that got UTF-8 re-encoded on write, corrupting every byte above 0x7F.
         */
        const content = isBinary ? base64 : new TextDecoder().decode(base64ToBytes(base64));

        return { name: file.path.split('/').pop() || '', path: file.path, content, isBinary };
      } catch (error) {
        console.warn(`Error fetching ${file.path}:`, error);
        return null;
      }
    });

    const batchResults = await Promise.all(batchPromises);
    fileContents.push(...(batchResults.filter(Boolean) as TemplateFile[]));

    if (i + batchSize < files.length) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  return fileContents;
}

async function fetchRepoContentsZip(repo: string, sha: string, githubToken?: string): Promise<TemplateFile[]> {
  // Always the zipball AT THE COMMIT — never `releases/latest`, never a moving branch name (see resolveTemplateRef).
  const zipResponse = await fetch(`${GITHUB_API}/repos/${repo}/zipball/${sha}`, { headers: headers(githubToken) });

  if (!zipResponse.ok) {
    throw new Error(`Failed to fetch template zipball: ${zipResponse.status} ${zipResponse.statusText}`);
  }

  const files = await extractZipFiles(await zipResponse.arrayBuffer());

  /**
   * Vendor git submodule contents (SPEC §4.4).
   *
   * A GitHub zipball NEVER contains submodule content — it records only a gitlink. Our
   * starter keeps the Babylon Toolkit React Framework at `src/babylon` this way, so the
   * mounted project was missing the entire framework and Vite failed with an unresolvable
   * `./babylon/…` import (historically "./babylon/custom/loading"; the chrome now lives at
   * `src/custom` outside the framework, but every `../babylon/globals` import fails the same
   * way without the vendored contents). WebContainers cannot run `git submodule`,
   * so the server resolves and inlines the contents here, at the pinned commit.
   */
  const submoduleFiles = await fetchSubmoduleFiles(repo, sha, githubToken);

  return [...files, ...submoduleFiles];
}

/** Extract a GitHub zipball, stripping its top-level `<owner>-<repo>-<sha>/` folder. */
async function extractZipFiles(zipArrayBuffer: ArrayBuffer, pathPrefix = ''): Promise<TemplateFile[]> {
  const zip = await JSZip.loadAsync(zipArrayBuffer);

  let rootFolderName = '';
  zip.forEach((relativePath) => {
    if (!rootFolderName && relativePath.includes('/')) {
      rootFolderName = relativePath.split('/')[0];
    }
  });

  const promises = Object.keys(zip.files).map(async (filename) => {
    const zipEntry = zip.files[filename];

    if (zipEntry.dir || filename === rootFolderName) {
      return null;
    }

    let normalizedPath = filename;

    if (rootFolderName && filename.startsWith(rootFolderName + '/')) {
      normalizedPath = filename.substring(rootFolderName.length + 1);
    }

    if (pathPrefix) {
      normalizedPath = `${pathPrefix}/${normalizedPath}`;
    }

    /**
     * Binary template assets (textures, models, audio, wasm) are extracted as base64 and
     * flagged, NOT decoded as a string. `zipEntry.async('string')` UTF-8 decodes, which
     * silently destroyed every binary in the starter template — the root cause of missing
     * `public/babylon.png` and Vite's "Failed to resolve import" (SPEC §4.4).
     */
    const isBinary = isBinaryPath(normalizedPath);
    const content = await zipEntry.async(isBinary ? 'base64' : 'string');

    return { name: normalizedPath.split('/').pop() || '', path: normalizedPath, content, isBinary };
  });

  return (await Promise.all(promises)).filter(Boolean) as TemplateFile[];
}

/**
 * Find every gitlink (mode 160000) in the repo tree and inline that submodule's files at
 * the exact commit the superproject pins.
 *
 * The submodule URL comes from `.gitmodules` when present. Our starter currently ships an
 * EMPTY `.gitmodules` (so even `git clone --recurse-submodules` could not resolve it), which
 * is why a config fallback exists — a template must still mount correctly today.
 */
async function fetchSubmoduleFiles(repo: string, sha: string, githubToken?: string): Promise<TemplateFile[]> {
  try {
    const treeResponse = await fetch(`${GITHUB_API}/repos/${repo}/git/trees/${sha}?recursive=1`, {
      headers: headers(githubToken),
    });

    if (!treeResponse.ok) {
      return [];
    }

    const tree = ((await treeResponse.json()) as any).tree as { path: string; mode: string; sha: string }[];
    const gitlinks = tree.filter((entry) => entry.mode === '160000');

    if (gitlinks.length === 0) {
      return [];
    }

    const urls = await fetchGitmodulesUrls(repo, sha, githubToken);
    const collected: TemplateFile[] = [];

    for (const link of gitlinks) {
      const source = urls[link.path] ?? SUBMODULE_FALLBACKS[`${repo}#${link.path}`];

      if (!source) {
        console.warn(`Unresolvable submodule at ${link.path} — project will be missing these files`);
        continue;
      }

      // Pin to the exact commit the superproject references.
      const subResponse = await fetch(`${GITHUB_API}/repos/${source}/zipball/${link.sha}`, {
        headers: headers(githubToken),
      });

      if (!subResponse.ok) {
        console.warn(`Failed to fetch submodule ${source}@${link.sha}: ${subResponse.status}`);
        continue;
      }

      collected.push(...(await extractZipFiles(await subResponse.arrayBuffer(), link.path)));
    }

    return collected;
  } catch (error) {
    console.warn('Submodule resolution failed:', error);
    return [];
  }
}

/** Parse `.gitmodules` into a `{ [submodulePath]: 'owner/repo' }` map. */
async function fetchGitmodulesUrls(repo: string, sha: string, githubToken?: string): Promise<Record<string, string>> {
  const response = await fetch(`${GITHUB_API}/repos/${repo}/contents/.gitmodules?ref=${sha}`, {
    headers: headers(githubToken),
  });

  if (!response.ok) {
    return {};
  }

  const raw = ((await response.json()) as any).content ?? '';
  const text = new TextDecoder().decode(base64ToBytes(raw.replace(/\s/g, '')));

  const urls: Record<string, string> = {};
  let currentPath: string | undefined;

  for (const line of text.split('\n')) {
    const pathMatch = line.match(/^\s*path\s*=\s*(.+?)\s*$/);
    const urlMatch = line.match(/^\s*url\s*=\s*(.+?)\s*$/);

    if (pathMatch) {
      currentPath = pathMatch[1];
    } else if (urlMatch && currentPath) {
      const slug = urlMatch[1].match(/github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/);

      if (slug) {
        urls[currentPath] = slug[1];
      }

      currentPath = undefined;
    }
  }

  return urls;
}
