/**
 * Slash-command parsing (SPEC §4.11, invocation path 1 — the headline feature of the subsystem).
 *
 * Shared by the client (autocomplete in the chat input) and the server (resolving the invocation),
 * so it lives OUTSIDE `~/lib/.server/**`. It is pure: no secrets, no privileged logic, no I/O.
 */

export interface SkillSummary {
  name: string;
  description: string;

  /**
   * True for built-in client commands (`/clear`, `/context`) that are merged into the same menu as
   * synced skills. Purely a sort hint — built-ins float to the top so they are always discoverable.
   */
  builtin?: boolean;
}

export interface SlashInvocation {
  /** The skill name typed after the slash. */
  name: string;

  /** Everything after the name — the task handed to the skill. May be empty. */
  args: string;
}

/**
 * Parse `/skill-name the rest is the task` out of a chat message.
 *
 * Only a slash at the very START of the message counts — a slash mid-sentence is prose ("and/or"),
 * and a file path in a message ("edit /src/main.ts") must never be mistaken for an invocation,
 * which is why the name must match the skill-name grammar (lowercase, hyphen-separated).
 */
export function parseSlashInvocation(message: string): SlashInvocation | null {
  const match = /^\/([a-z0-9]+(?:-[a-z0-9]+)*)(?:\s+([\s\S]*))?$/.exec(message.trim());

  if (!match) {
    return null;
  }

  return { name: match[1], args: (match[2] ?? '').trim() };
}

/**
 * Autocomplete state for the chat input: is the user mid-`/`-command, and which skills match?
 *
 * Returns null unless the cursor is in a slash token at the start of the input — so typing a path
 * or a normal sentence never pops the menu.
 */
export function getSlashAutocomplete(
  input: string,
  skills: SkillSummary[],
): { query: string; matches: SkillSummary[] } | null {
  // Only the first token, and only if the message begins with `/` and has no whitespace yet.
  const match = /^\/([a-z0-9-]*)$/.exec(input);

  if (!match) {
    return null;
  }

  const query = match[1].toLowerCase();
  const matches = skills
    .filter((skill) => skill.name.toLowerCase().includes(query))
    .sort((a, b) => {
      // Built-in commands (/clear, /context) always lead — they are the shortest path and easy to miss.
      const builtin = Number(Boolean(b.builtin)) - Number(Boolean(a.builtin));

      if (builtin !== 0) {
        return builtin;
      }

      // Prefix matches next — typing "bt-s" should put bt-spec above anything merely containing it.
      const aPrefix = a.name.toLowerCase().startsWith(query) ? 0 : 1;
      const bPrefix = b.name.toLowerCase().startsWith(query) ? 0 : 1;

      return aPrefix - bPrefix || a.name.localeCompare(b.name);
    });

  return { query, matches };
}
