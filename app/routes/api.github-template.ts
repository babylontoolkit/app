import { json } from '@remix-run/cloudflare';
import JSZip from 'jszip';
import { base64ToBytes, isBinaryPath } from '~/lib/binary/binary-files';

interface TemplateFile {
  name: string;
  path: string;

  /** base64 when `isBinary`, UTF-8 text otherwise. */
  content: string;
  isBinary: boolean;
}

/**
 * Submodule URLs for templates whose `.gitmodules` does not resolve (config, not code —
 * keyed by `<owner/repo>#<submodule path>`).
 *
 * Empty by design: our starter now vendors the React Framework directly at `src/babylon`.
 * This exists so a template that DOES use a submodule with a missing/empty `.gitmodules`
 * can still be mounted without a code change (SPEC §4.4).
 */
const SUBMODULE_FALLBACKS: Record<string, string> = {};

// Function to detect if we're running in Cloudflare
function isCloudflareEnvironment(context: any): boolean {
  // Check if we're in production AND have Cloudflare Pages specific env vars
  const isProduction = process.env.NODE_ENV === 'production';
  const hasCfPagesVars = !!(
    context?.cloudflare?.env?.CF_PAGES ||
    context?.cloudflare?.env?.CF_PAGES_URL ||
    context?.cloudflare?.env?.CF_PAGES_COMMIT_SHA
  );

  return isProduction && hasCfPagesVars;
}

// Cloudflare-compatible method using GitHub Contents API
async function fetchRepoContentsCloudflare(repo: string, githubToken?: string) {
  const baseUrl = 'https://api.github.com';

  // Get repository info to find default branch
  const repoResponse = await fetch(`${baseUrl}/repos/${repo}`, {
    headers: {
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'bolt.diy-app',
      ...(githubToken ? { Authorization: `Bearer ${githubToken}` } : {}),
    },
  });

  if (!repoResponse.ok) {
    throw new Error(`Repository not found: ${repo}`);
  }

  const repoData = (await repoResponse.json()) as any;
  const defaultBranch = repoData.default_branch;

  // Get the tree recursively
  const treeResponse = await fetch(`${baseUrl}/repos/${repo}/git/trees/${defaultBranch}?recursive=1`, {
    headers: {
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'bolt.diy-app',
      ...(githubToken ? { Authorization: `Bearer ${githubToken}` } : {}),
    },
  });

  if (!treeResponse.ok) {
    throw new Error(`Failed to fetch repository tree: ${treeResponse.status}`);
  }

  const treeData = (await treeResponse.json()) as any;

  // Filter for files only (not directories) and limit size
  const files = treeData.tree.filter((item: any) => {
    if (item.type !== 'blob') {
      return false;
    }

    if (item.path.startsWith('.git/')) {
      return false;
    }

    // Allow lock files even if they're large
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

    // For non-lock files, limit size to 100KB
    if (!isLockFile && item.size >= 100000) {
      return false;
    }

    return true;
  });

  // Fetch file contents in batches to avoid overwhelming the API
  const batchSize = 10;
  const fileContents = [];

  for (let i = 0; i < files.length; i += batchSize) {
    const batch = files.slice(i, i + batchSize);
    const batchPromises = batch.map(async (file: any) => {
      try {
        const contentResponse = await fetch(`${baseUrl}/repos/${repo}/contents/${file.path}`, {
          headers: {
            Accept: 'application/vnd.github.v3+json',
            'User-Agent': 'bolt.diy-app',
            ...(githubToken ? { Authorization: `Bearer ${githubToken}` } : {}),
          },
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

        return {
          name: file.path.split('/').pop() || '',
          path: file.path,
          content,
          isBinary,
        };
      } catch (error) {
        console.warn(`Error fetching ${file.path}:`, error);
        return null;
      }
    });

    const batchResults = await Promise.all(batchPromises);
    fileContents.push(...batchResults.filter(Boolean));

    // Add a small delay between batches to be respectful to the API
    if (i + batchSize < files.length) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  return fileContents;
}

// Your existing method for non-Cloudflare environments
/**
 * Treat an unset or placeholder token as NO token.
 *
 * Public templates (our starter included) are fetchable unauthenticated. A stock
 * `.env.example` value like `your_github_token_here` was being sent as a real Bearer,
 * turning a working anonymous fetch into a hard 401 — a missing credential must degrade
 * gracefully, never break a path that works without it (SPEC §1.3 principle 0).
 */
function resolveGitHubToken(token?: string): string | undefined {
  const trimmed = token?.trim();

  if (!trimmed || /^(your_|<|\$\{|xxx|changeme|placeholder)/i.test(trimmed)) {
    return undefined;
  }

  return trimmed;
}

async function fetchRepoContentsZip(repo: string, githubToken?: string) {
  const baseUrl = 'https://api.github.com';

  const headers = (): Record<string, string> => ({
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'bolt.diy-app',
    ...(githubToken ? { Authorization: `Bearer ${githubToken}` } : {}),
  });

  // Get the latest release
  const releaseResponse = await fetch(`${baseUrl}/repos/${repo}/releases/latest`, { headers: headers() });

  /**
   * Fall back to the DEFAULT BRANCH zipball when a repo publishes no releases.
   *
   * Our starter (`babylontoolkit/AppTemplate`) is a template repo tracking `main` with no
   * releases at all, so requiring `releases/latest` made template mounting fail outright
   * (404) — before any binary handling even came into play (SPEC §4.4).
   */
  let zipballUrl: string;

  if (releaseResponse.ok) {
    zipballUrl = ((await releaseResponse.json()) as any).zipball_url;
  } else if (releaseResponse.status === 404) {
    zipballUrl = `${baseUrl}/repos/${repo}/zipball`;
  } else {
    throw new Error(`GitHub API error: ${releaseResponse.status} - ${releaseResponse.statusText}`);
  }

  // Fetch the zipball
  const zipResponse = await fetch(zipballUrl, { headers: headers() });

  if (!zipResponse.ok) {
    throw new Error(`Failed to fetch template zipball: ${zipResponse.status} ${zipResponse.statusText}`);
  }

  // Get the zip content as ArrayBuffer
  const zipArrayBuffer = await zipResponse.arrayBuffer();
  const files = await extractZipFiles(zipArrayBuffer);

  /**
   * Vendor git submodule contents (SPEC §4.4).
   *
   * A GitHub zipball NEVER contains submodule content — it records only a gitlink. Our
   * starter keeps the Babylon Toolkit React Framework at `src/babylon` this way, so the
   * mounted project was missing the entire framework and Vite failed with
   * "Could not resolve ./babylon/custom/loading". WebContainers cannot run `git submodule`,
   * so the server resolves and inlines the contents here, at the pinned commit.
   */
  const submoduleFiles = await fetchSubmoduleFiles(repo, headers);

  return [...files, ...submoduleFiles];
}

/** Extract a GitHub zipball, stripping its top-level `<owner>-<repo>-<sha>/` folder. */
async function extractZipFiles(zipArrayBuffer: ArrayBuffer, pathPrefix = ''): Promise<TemplateFile[]> {
  const zip = await JSZip.loadAsync(zipArrayBuffer);

  // Find the root folder name
  let rootFolderName = '';
  zip.forEach((relativePath) => {
    if (!rootFolderName && relativePath.includes('/')) {
      rootFolderName = relativePath.split('/')[0];
    }
  });

  const promises = Object.keys(zip.files).map(async (filename) => {
    const zipEntry = zip.files[filename];

    // Skip directories and the root folder itself
    if (zipEntry.dir || filename === rootFolderName) {
      return null;
    }

    // Remove the root folder from the path
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

    return {
      name: normalizedPath.split('/').pop() || '',
      path: normalizedPath,
      content,
      isBinary,
    };
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
async function fetchSubmoduleFiles(repo: string, headers: () => Record<string, string>): Promise<TemplateFile[]> {
  const baseUrl = 'https://api.github.com';

  try {
    const repoResponse = await fetch(`${baseUrl}/repos/${repo}`, { headers: headers() });

    if (!repoResponse.ok) {
      return [];
    }

    const defaultBranch = ((await repoResponse.json()) as any).default_branch || 'main';

    const treeResponse = await fetch(`${baseUrl}/repos/${repo}/git/trees/${defaultBranch}?recursive=1`, {
      headers: headers(),
    });

    if (!treeResponse.ok) {
      return [];
    }

    const tree = ((await treeResponse.json()) as any).tree as { path: string; mode: string; sha: string }[];
    const gitlinks = tree.filter((entry) => entry.mode === '160000');

    if (gitlinks.length === 0) {
      return [];
    }

    const urls = await fetchGitmodulesUrls(repo, headers);
    const collected: TemplateFile[] = [];

    for (const link of gitlinks) {
      const source = urls[link.path] ?? SUBMODULE_FALLBACKS[`${repo}#${link.path}`];

      if (!source) {
        console.warn(`Unresolvable submodule at ${link.path} — project will be missing these files`);
        continue;
      }

      // Pin to the exact commit the superproject references.
      const subResponse = await fetch(`${baseUrl}/repos/${source}/zipball/${link.sha}`, { headers: headers() });

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
async function fetchGitmodulesUrls(
  repo: string,
  headers: () => Record<string, string>,
): Promise<Record<string, string>> {
  const response = await fetch(`https://api.github.com/repos/${repo}/contents/.gitmodules`, { headers: headers() });

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

export async function loader({ request, context }: { request: Request; context: any }) {
  const url = new URL(request.url);
  const repo = url.searchParams.get('repo');

  if (!repo) {
    return json({ error: 'Repository name is required' }, { status: 400 });
  }

  try {
    // Access environment variables from Cloudflare context or process.env
    const githubToken = resolveGitHubToken(
      context?.cloudflare?.env?.GITHUB_TOKEN || process.env.GITHUB_TOKEN || process.env.VITE_GITHUB_ACCESS_TOKEN,
    );

    let fileList;

    if (isCloudflareEnvironment(context)) {
      fileList = await fetchRepoContentsCloudflare(repo, githubToken);
    } else {
      fileList = await fetchRepoContentsZip(repo, githubToken);
    }

    // Filter out .git files for both methods
    const filteredFiles = fileList.filter((file: any) => !file.path.startsWith('.git'));

    return json(filteredFiles);
  } catch (error) {
    console.error('Error processing GitHub template:', error);
    console.error('Repository:', repo);
    console.error('Error details:', error instanceof Error ? error.message : String(error));

    return json(
      {
        error: 'Failed to fetch template files',
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  }
}
