/**
 * The URL-safe base for a restored chat's `urlId` (SPEC §4.5.6).
 *
 * 🔴 **A chat with no `urlId` is INVISIBLE.** The sidebar renders only chats with both a `urlId` and a
 * `description` (`Menu.client.tsx`), so a restore that wrote `urlId: undefined` put the conversation in
 * IndexedDB where nothing could show it and nothing could address it. It was reported as "no chats at
 * all show in the left sidebar", and it is indistinguishable from data loss from the outside.
 *
 * A restore has no `firstArtifact` to borrow a slug from — that is upstream's source, and it only
 * exists once a generation has streamed an artifact in THIS tab. So the title is the base, because it
 * is what the user recognises, and the project id is the fallback.
 *
 * Its own module because `useChatHistory` opens IndexedDB and pulls in the workbench at import time:
 * a pure function that decides whether a chat is visible should be testable without any of that.
 */

/**
 * Never returns an empty string — that is the whole point. `getUrlId` de-duplicates the result against
 * existing slugs, so two projects called "Kart Racer" become `kart-racer` and `kart-racer-2`.
 */
export function slugForChat(title: string | undefined, projectId: string): string {
  const fromTitle = (title ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');

  return fromTitle || projectId;
}
