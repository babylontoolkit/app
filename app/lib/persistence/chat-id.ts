/**
 * What a chat id is (SPEC §4.5.6) — ONE rule, in ONE place.
 *
 * Client-safe by construction (no imports, no state), because both sides need it and they must not be
 * able to disagree: the server refuses to store a chat at an id that fails this, and the client uses it
 * to decide whether `/chat/:id` is worth asking the server about. Two copies of a rule like that drift,
 * and the drift shows up as "the sidebar links somewhere the server 400s on".
 *
 * That lesson is already paid for here — `isSecretPath` (`git/sync-logic.ts`) is one rule in one place
 * because the narrower second copy it replaced pushed `.env.production` to a public repo.
 *
 * ## Why a UUID and nothing else
 *
 * It is a whitelist, so a new way to write a nasty string is refused by default rather than needing a
 * new rule. Three things it says no to, each for its own reason:
 *
 *   - `../../seeds/{someone}` — a path traversal out of the project's prefix, since the id becomes an
 *     object key (`messages/{projectId}/{id}.json`).
 *   - `"1"` — a browser's local chat id, which is `max(local keys) + 1`. Every browser's first chat is
 *     "1", so accepting it makes a laptop's chat and a desktop's chat the same object, and one silently
 *     destroys the other.
 *   - `start-dev-server` — a title slug. It was the URL until 2026-07-16 and could never be a key: it is
 *     not unique across users, and the de-duplication that produced it (`getUrlId`) can only see ONE
 *     browser's IndexedDB, so it cannot know about anyone else's.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Is this an id we could have minted — i.e. one the server could know about? */
export function isServerChatId(id: string): boolean {
  return UUID_RE.test(id);
}
