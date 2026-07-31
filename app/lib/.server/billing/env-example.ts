/**
 * ONE counter for "how many times does `.env.example` assign this key?".
 *
 * `.env.example` is copied to make a real `.env`, where a LATER line silently WINS. `SIGNUP_GRANT_CREDITS`
 * was once assigned twice in that file with different values (500 up top, 1000 in the billing block), so
 * copying it handed out the wrong grant — and nothing threw. The file now carries prose warning about
 * that, and a prose warning cannot fail; the duplicate-key pins are what replaced it.
 *
 * ⚠️ **A COMMENTED DUPLICATE COUNTS.** That is the whole point: `# PREMIUM_MODEL=claude-opus-5` sitting
 * in a documentation block is one uncomment away from being the line that wins, and an operator reading
 * a block that names the variable will reasonably uncomment it. So the match tolerates any leading `#`
 * and whitespace.
 *
 * ## Why this is a module and not a regex written twice
 *
 * There were two duplicate-key pins in this codebase before this file existed (`PROJECT_CREATE_CREDITS`
 * in `project-create.spec.ts`, and the §4.6.1a ladder keys), each with its own inline regex. Two
 * counters that disagree about what counts as an assignment is the drift this repo keeps rediscovering —
 * and the failure is silent in the safe-looking direction: a counter that is a little too strict reports
 * "no duplicates" forever. One function, every caller, and a CONTROL in the specs proving it still
 * matches something.
 *
 * Test-support only — it is imported by specs, never by a request path.
 */

/** Where `.env.example` lives, relative to the repo root (which is vitest's `process.cwd()`). */
export const ENV_EXAMPLE_FILENAME = '.env.example';

/**
 * Every line of `source` that ASSIGNS `key`, commented or not, in file order.
 *
 * Matches a line whose first non-`#`, non-whitespace content is `KEY=` — so a prose line that merely
 * MENTIONS the variable mid-sentence (`# A commented \`# PREMIUM_MODEL=...\` here would be a second
 * assignment`) is correctly not an assignment, while `#PREMIUM_MODEL=x`, `# PREMIUM_MODEL = x` and
 * `  ## PREMIUM_MODEL=x` all are.
 */
export function envExampleAssignments(source: string, key: string): string[] {
  const pattern = new RegExp(`^\\s*#*\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=`);

  return source.split('\n').filter((line) => pattern.test(line));
}

/**
 * The value assigned to `key`, or `undefined` if it is not assigned exactly once.
 *
 * Deliberately refuses to answer when there are duplicates: with two assignments the "value" depends on
 * which line an operator ends up with, which is precisely the state the count assertions exist to
 * forbid. A caller reading a value must have already pinned the count.
 */
export function envExampleValue(source: string, key: string): string | undefined {
  const assignments = envExampleAssignments(source, key);

  if (assignments.length !== 1) {
    return undefined;
  }

  const value = assignments[0].slice(assignments[0].indexOf('=') + 1).trim();

  return value.length > 0 ? value : undefined;
}
