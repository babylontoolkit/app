/**
 * Where a project file can be FETCHED from, for the Code-view binary preview (SPEC §4.1b).
 *
 * 🔴 **Nothing here reads a byte, and that is the whole design.** The project's own Vite dev server is
 * already serving these files with the right `Content-Type` (the starter's `MEDIA_MIME_TYPES`
 * middleware), so the viewer points an element at a URL instead of pulling bytes into the tab. That
 * retires two hazards outright rather than defending against them: the §1.3-principle-10 rule that the
 * sandbox FS is the single source of truth for binary bytes (`spec/binary-files.md`), and the
 * `readFile`-bytes-are-on-loan detachment class (Nodepod's `readFile` returns a live view into its own
 * VFS). It also buys HTTP range requests for free, so a 200 MB video seeks instantly and never occupies
 * the heap — which a `blob:` URL could not have delivered at any size.
 *
 * 🔴 **The join is DELEGATED to `previewUrlWithPath`, never re-implemented here.** That function's doc
 * comment records two live defects it exists to prevent: a CodeSandbox base carries `?preview_token=…`
 * (so `base + path` glues the path onto the QUERY), and Nodepod mounts previews same-origin at
 * `/__virtual__/<pod>/<port>` (so ASSIGNING `pathname` rewrites the URL to the builder page instead of
 * the game). A second copy of that rule here would re-derive both bugs, plus the trailing-slash
 * handling it already owns. Same reasoning as `isSecretPath` and `toSandboxStoreKey`: one path rule,
 * one place.
 *
 * Both exports are pure and read no store, so the component can be tested without a sandbox and the
 * URL rules can be tested without a browser.
 */

import { toProjectRelativePath, toSandboxStoreKey } from '~/lib/common/sandbox-paths';
import type { PreviewInfo } from '~/lib/stores/previews';
import { previewUrlWithPath } from '~/lib/stores/preview-url';

/**
 * The base URL of the preview we can actually fetch from, or `undefined` if there is none.
 *
 * ⚠️ Deliberately stricter than `Preview.tsx`'s `previews[activePreviewIndex]`, which does **not**
 * filter on `ready`. That is right for an iframe — showing a booting server is better than showing
 * nothing — and wrong here: an un-`ready` preview 404s every `<img>` on the page, and a broken-image
 * icon is a worse answer than FR-4's named "start the dev server" state. So a preview counts only once
 * it is serving.
 */
export function selectPreviewBaseUrl(previews: PreviewInfo[]): string | undefined {
  return previews.find((preview) => preview.ready === true && !!preview.baseUrl)?.baseUrl;
}

/**
 * The URL the running preview serves `filePath` at, or `null` when it cannot be served.
 *
 * `null` is a real answer, not a failure: with no preview up there is nothing to point at, and FR-4's
 * named state is the honest thing to render.
 *
 * Two branches, because Vite serves the project two ways:
 * - **`public/`** is served AT THE PREVIEW ROOT (`publicDir`), so the prefix is stripped:
 *   `public/assets/generated/hero.jpg` → `<base>/assets/generated/hero.jpg`. The match is on exactly
 *   the first segment — `src/public/x.png` and `publicity/x.png` are ordinary project files.
 * - **everything else** goes through Vite's `/@fs/<absolute path>` door, which the starter's
 *   `server.fs.allow: ['..']` permits for anything in or one level above the project root. Verified
 *   live on Nodepod 2026-08-14 (`/@fs/home/project/src/assets/hero.png` → 200 `image/png`).
 *
 * The path is rebased through `sandbox-paths` rather than sliced here, because the FileMap is keyed
 * sandbox-ABSOLUTE and the root is a property of the PROVIDER (`/home/project` vs `/project/workspace`)
 * — a literal here would be a banned spelling and would silently no-op on the other provider.
 */
export function previewUrlForProjectFile(
  filePath: string,
  baseUrl: string | undefined,
  workdir: string,
): string | null {
  if (!baseUrl) {
    return null;
  }

  const relative = toProjectRelativePath(filePath);

  if (!relative) {
    return null;
  }

  const path = relative.startsWith('public/')
    ? relative.slice('public'.length) // keeps the leading '/', so `public/a.png` → `/a.png`
    : `/@fs${toSandboxStoreKey(filePath, workdir)}`;

  return previewUrlWithPath(baseUrl, path);
}
