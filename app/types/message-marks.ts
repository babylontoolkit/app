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
