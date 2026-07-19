/**
 * Client-side chat commands (SPEC §4.5.6).
 *
 * `/clear` is the Claude-Code-style spelling of "New chat, same game": drop the conversation context,
 * keep the project. It must be intercepted in the BROWSER, before the message is posted — a cleared
 * context that costs a server round-trip has already re-sent the uncached history it exists to shed
 * (`spec/context-budget.md`), and billed a generation for a message that was never for the model.
 *
 * Deliberately EXACT-match only (after trimming, case-insensitive). `/clear` with anything after it is
 * NOT a client command: server `/slash` invocations are skill names with optional args, and a prefix
 * match here would silently swallow a message the user meant for the agent. An unknown `/word` falling
 * through to the server is harmless; a swallowed real message is not.
 *
 * Pure and separately tested, per the repo rule for anything that decides whether a user's message is
 * sent or not — both failure modes are silent (a swallowed message, or a "/clear" that generates).
 */
export type ClientCommand = { kind: 'clear' } | { kind: 'context' };

/** Spellings that all mean "clear my context": the Claude Code verb plus the product's own noun. */
const CLEAR_ALIASES = ['/clear', '/new', '/newchat'];

/** `/context` — show what this conversation is costing and how close the history window is (§4.5.6). */
const CONTEXT_ALIASES = ['/context', '/usage'];

export function parseClientCommand(message: string): ClientCommand | null {
  const normalized = message.trim().toLowerCase();

  if (CLEAR_ALIASES.includes(normalized)) {
    return { kind: 'clear' };
  }

  if (CONTEXT_ALIASES.includes(normalized)) {
    return { kind: 'context' };
  }

  return null;
}
