/**
 * "Reload the running preview — for real." (§4.13a, §4.16.)
 *
 * ## The defect this ends
 *
 * Reported 2026-08-22: *"When I switched the branch, the preview did not work. I had to actually
 * RELOAD the page, then I could see the preview from the branch I switched to."*
 *
 * Two faults, stacked. **(a)** `applyBranchTree` never asked for a preview reload at all — it replaces
 * the entire module graph, every `public/` asset, and reinstalls and restarts the dev server, and then
 * left the iframe pointing at a document built from the branch the user had just left. **(b)** The
 * mechanism it would have called was already dead: `PreviewsStore.refreshPreview` flips
 * `PreviewInfo.ready` false→true inside a `requestAnimationFrame`, and **`ready` has no readers** — it
 * is written in three places in `previews.ts` and read nowhere in the app. The iframe carries no `key`
 * and its `src` is unchanged, so React re-rendered exactly the same element and the browser was never
 * asked for anything.
 *
 * ⚠️ So `workbenchStore.refreshPreviews()` — whose comment states that "the local remount
 * (`refreshPreview`, which flips `ready` off and back on) has to be driven here" — did nothing in the
 * tab that called it. Its BroadcastChannel half genuinely works, and a channel never delivers to the
 * context that posted, so the one tab that could not be refreshed was the one the user was looking at.
 * That also means §4.16's generated media has had the same bug: the render lands ~30s after the `<img>`
 * 404s, `refreshPreviews()` is called to re-request it, and nothing happens until a manual reload.
 *
 * ## Why a signal rather than a fix inside the store
 *
 * The only code that can genuinely reload a preview is `Preview.tsx`'s `reloadPreview`, and it has to
 * live there: it re-mints the URL through `currentPreviewUrl(port)` before assigning `iframe.src`,
 * because on a provider whose preview URL carries an expiring credential `iframe.src = iframe.src`
 * re-requests the SAME dead token — reloading the provider's 401 page at precisely the moment someone
 * wanted their preview back. That knowledge belongs to the component holding the ref.
 *
 * So the store asks and the component answers. A monotonic counter for `tree-revision.ts`'s reason: the
 * reader needs to know it changed since it last looked, and two requests in a row must read as two.
 */
import { atom } from 'nanostores';

/** How many preview reloads have been requested this page load. Only changes are meaningful. */
export const previewReloadRequest = atom(0);

/**
 * Ask every mounted preview to reload.
 *
 * Callers go through `workbenchStore.refreshPreviews()`, which also broadcasts to other tabs — this is
 * the local half, exported so the signal has one writer rather than an inline `.set(x + 1)`.
 */
export function requestPreviewReload(): void {
  previewReloadRequest.set(previewReloadRequest.get() + 1);
}

/** Test-only reset, so one spec's requests cannot make the next spec's reader fire. */
export function resetPreviewReloadRequests(): void {
  previewReloadRequest.set(0);
}
