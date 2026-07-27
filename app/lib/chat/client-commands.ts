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
import type { SkillSummary } from '~/lib/skills/slash';

export type ClientCommand = { kind: 'clear' } | { kind: 'context' } | { kind: 'effort' };

/** Spellings that all mean "clear my context": the Claude Code verb plus the product's own noun. */
const CLEAR_ALIASES = ['/clear', '/new', '/newchat'];

/** `/context` — show what this conversation is costing and how close the history window is (§4.5.6). */
const CONTEXT_ALIASES = ['/context', '/usage'];

/**
 * `/effort` — open the thinking-effort picker (§4.2.9). A PANEL, not an argument form: `/effort high`
 * would be a prefix match, and the whole point of exact-matching here is that a message the user meant
 * for the agent ("/effort high on the physics, please") is never silently swallowed. The picker also
 * shows what each level costs, which a bare command cannot.
 */
const EFFORT_ALIASES = ['/effort', '/thinking'];

/**
 * The built-in commands surfaced in the `/` autocomplete menu, alongside synced skills.
 *
 * Only the canonical spelling is listed (not every alias) — the menu is discovery, not a thesaurus.
 * `builtin: true` floats them to the top of the menu; `takesArgs: false` tells `accept` to complete
 * them with NO trailing space, because any text after the command turns it back into a plain message.
 */
export const CLIENT_COMMAND_SUMMARIES: (SkillSummary & { takesArgs: false })[] = [
  {
    name: 'clear',
    description: 'New chat, same game — clear the conversation context, keep the project. Free, no server call.',
    builtin: true,
    takesArgs: false,
  },
  {
    name: 'context',
    description: 'Show what this conversation is costing and how full the history window is.',
    builtin: true,
    takesArgs: false,
  },
  {
    name: 'effort',
    description: 'Set how hard the model thinks this session — Medium (default) or High. Free, no server call.',
    builtin: true,
    takesArgs: false,
  },
];

/** True when a completed `/name` is a zero-arg client command — used by autocomplete to skip the trailing space. */
export function isClientCommandName(name: string): boolean {
  return CLIENT_COMMAND_SUMMARIES.some((command) => command.name === name);
}

export function parseClientCommand(message: string): ClientCommand | null {
  const normalized = message.trim().toLowerCase();

  if (CLEAR_ALIASES.includes(normalized)) {
    return { kind: 'clear' };
  }

  if (CONTEXT_ALIASES.includes(normalized)) {
    return { kind: 'context' };
  }

  if (EFFORT_ALIASES.includes(normalized)) {
    return { kind: 'effort' };
  }

  return null;
}
