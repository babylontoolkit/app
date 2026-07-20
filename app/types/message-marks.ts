/**
 * Message annotation marks shared by the server routes and the client parser (like
 * `types/creation.ts`, this exists so BOTH sides import ONE constant — a string literal in two places
 * is a silent-drift bug on the exact path where being wrong writes stale files).
 *
 * `NO_REPLAY` marks an assistant message whose actions must be RENDERED but never EXECUTED
 * (`useMessageParser`'s transcript parser). Two writers:
 *
 *  - the client, when restoring a conversation from the server (§4.5.4b) — replaying a stale
 *    `<boltAction type="file">` over a repo-mounted project writes old bodies over the user's files;
 *  - the SERVER, on a Discussion-mode generation (§4.2.9) — written as a message annotation BEFORE the
 *    text streams, so a disobedient artifact renders as a proposal and can never touch the filesystem.
 *    That ordering is the hard wall: annotate after the text and the parser has already run the actions.
 *
 * An annotation rather than a field because `Message` is the AI SDK's type and annotations are its
 * sanctioned extension point; it survives the IndexedDB round-trip, so a reload cannot lose the mark.
 */
export const NO_REPLAY = 'no-replay';

/**
 * `PLAN_MODE` marks an assistant message that was produced on a Plan-mode (Discussion, §4.2.9) turn.
 * Written by the SERVER alongside `NO_REPLAY` when `discussMode` is set.
 *
 * It exists to DISTINGUISH a plan-mode message from the OTHER writer of `NO_REPLAY` — a restored
 * historical message (a build turn gets `NO_REPLAY` on restore too, §4.5.4b). Only a plan turn ever
 * carries `PLAN_MODE`, so the client can safely offer a "Build & Apply" affordance on a plan turn that
 * proposed writes without ever showing it on a restored build message whose files are already applied.
 *
 * Like `NO_REPLAY`, an annotation (not a field) so it survives the IndexedDB round-trip.
 */
export const PLAN_MODE = 'plan-mode';
