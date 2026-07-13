/**
 * Shell action allow-list (SPEC §4.2.5, §5 — a standing never-violate rule).
 *
 * The agent may run EXACTLY two kinds of command in the user's WebContainer:
 *   - `npm install [packages…]`
 *   - `npm run <script>`
 *
 * Everything else is refused. The system prompt also instructs the model to stay inside this set,
 * but a prompt is guidance, not a control: this is the enforcement point, because the WebContainer
 * shell is where a command actually runs. An allow-list (deny by default) rather than a deny-list —
 * a deny-list of "dangerous" commands is a game you lose to the first construction you didn't think
 * of.
 */

export interface AllowListResult {
  allowed: boolean;

  /** Why it was refused — surfaced to the user and to the model, so it can correct itself. */
  reason?: string;
}

/**
 * Shell metacharacters. Their presence means the string is doing something other than running one
 * plain command — chaining, substituting, redirecting — so we refuse it rather than try to reason
 * about what it would expand to. `&&` is handled separately (split before this check).
 */
const METACHARACTERS = /[;|`$(){}<>\n\r\\]|&(?!&)/;

/** A package spec (`react`, `@babylonjs/core`, `foo@^1.2.3`, `./local`) or a flag (`--save-dev`). */
const INSTALL_ARG = /^(?:-{1,2}[a-zA-Z][\w-]*|[@\w./~^-][\w@./:^~-]*)$/;

/** An npm script name as it appears in package.json (`dev`, `build`, `test:unit`). */
const RUN_SCRIPT = /^[\w:.-]+$/;

function checkSegment(segment: string): AllowListResult {
  const command = segment.trim();

  if (!command) {
    return { allowed: false, reason: 'Empty command.' };
  }

  if (METACHARACTERS.test(command)) {
    return {
      allowed: false,
      reason: `Shell metacharacters are not permitted: ${command}`,
    };
  }

  const tokens = command.split(/\s+/);
  const [program, subcommand, ...args] = tokens;

  if (program !== 'npm') {
    return {
      allowed: false,
      reason: `Only "npm install" and "npm run" are permitted; got "${program}".`,
    };
  }

  if (subcommand === 'install' || subcommand === 'i') {
    const bad = args.find((arg) => !INSTALL_ARG.test(arg));

    if (bad) {
      return { allowed: false, reason: `"${bad}" is not a valid package or flag for npm install.` };
    }

    return { allowed: true };
  }

  if (subcommand === 'run') {
    if (args.length !== 1) {
      return { allowed: false, reason: 'npm run takes exactly one script name.' };
    }

    if (!RUN_SCRIPT.test(args[0])) {
      return { allowed: false, reason: `"${args[0]}" is not a valid npm script name.` };
    }

    return { allowed: true };
  }

  return {
    allowed: false,
    reason: `Only "npm install" and "npm run" are permitted; got "npm ${subcommand ?? ''}".`.trim(),
  };
}

/**
 * Validate a shell action's command. `a && b` is permitted only when EVERY segment is permitted —
 * chaining two allowed installs is fine; smuggling a second command behind an allowed one is not.
 */
export function isAllowedShellCommand(command: string): AllowListResult {
  const segments = command.split('&&');

  for (const segment of segments) {
    const result = checkSegment(segment);

    if (!result.allowed) {
      return result;
    }
  }

  return { allowed: true };
}
