/**
 * Turning a failed share build into something the user can act on (SPEC §4.8).
 *
 * 🔴 **WHY THIS EXISTS — the compiler error was captured and then thrown away TWICE, so a project
 * that simply did not compile presented as "Share is broken".** Measured live (2026-08-01): a game
 * whose `src/scripts/<Mode>.ts` assigned a property that does not exist failed `tsc -b` with an exact
 * file, line, column and TS code — and the user got a red toast reading *"The project failed to build.
 * Fix the errors in the editor and try again."* with no indication of WHICH error or WHERE. Told to go
 * to the editor and fix something, with nothing naming it, the only available conclusion is that the
 * Share button is at fault.
 *
 * Both silencers were independent, and neither throws:
 *
 *   1. `useShareGame`'s `buildProject` threw a hardcoded sentence and dropped `buildOutput.output` —
 *      the field that holds the entire compiler log — on the floor.
 *   2. The `DeployAlert` that DOES carry `content: output` is suppressed for any artifact belonging to
 *      a RELOADED message (`workbench.ts` — `#reloadedMessages`), and Share runs against
 *      `firstArtifact`, which after any page reload is exactly that. So the one surface that would
 *      have shown the log is silent in the common case, and loud only in a session that has never
 *      reloaded — i.e. it works while you are developing it and not for the user.
 *
 * Hence a pure module: the rules below are all "what do we show a person whose publish just failed",
 * and every one of them fails silently in a way that looks like a platform bug rather than a project
 * bug.
 *
 * ⚠️ This decides PRESENTATION only. It never decides whether the build failed — an exit code does
 * that — and it must never be able to turn a failure into a success.
 */

/**
 * How much of the log may reach the dialog.
 *
 * A build log is unbounded (a project with a hundred type errors prints a hundred), and this lands in
 * the DOM inside a fixed-size dialog. The cap is generous enough for the handful of errors anyone can
 * actually act on in one sitting and small enough that a pathological log cannot bloat the page.
 */
export const MAX_BUILD_DETAIL_CHARS = 4_000;

/** Shown when the log tells us nothing more specific. Kept verbatim from the original throw. */
export const GENERIC_BUILD_FAILURE = 'The project failed to build. Fix the errors in the editor and try again.';

/** Marks a log that was cut. Without it, a truncated log reads as a complete one that starts mid-sentence. */
export const TRUNCATION_NOTICE = '… earlier build output omitted …';

export interface BuildFailureInput {
  /** The build process's exit code. Non-zero is the only way to get here. */
  exitCode: number;

  /** Everything the build wrote to stdout/stderr, ANSI colour codes and all. */
  output: string;

  /**
   * Set when the build stopped RESPONDING rather than failing (`build-stall.ts`). A different fact
   * about the world, and conflating the two sends the user hunting for a compile error they do not
   * have.
   */
  stalledReason?: string;
}

export interface BuildFailure {
  /** One sentence, safe to put in a toast or a heading. */
  message: string;

  /** The build log, cleaned and capped. `undefined` when there is nothing worth showing. */
  detail?: string;
}

/*
 * Terminal escape sequences: colour, cursor moves, erases. `tsc` colourises its output whenever it
 * believes it has a TTY, and Nodepod's spawn gives it one — so the raw log is full of `[96m`.
 * Rendered into HTML those become literal `[96m` noise wrapped around every filename, which makes an
 * already-bad moment look broken as well as unhelpful.
 *
 * 🔴 The leading `` is the safety of this pattern, not decoration — and it is written as an
 * ESCAPE rather than a literal ESC byte so that a reader can SEE it. Drop it and the rest of the
 * class matches an ordinary bracketed word: `[vite]: Rollup failed to resolve import` silently loses
 * its `[vite]`, and a code frame containing `[0]` is quietly rewritten. A sanitiser that edits the
 * text it exists to show faithfully is worse than no sanitiser, and an invisible control character is
 * exactly the kind of thing a later edit deletes without noticing.
 */

const ANSI_PATTERN = /\u001b\[[0-9;?]*[\x20-\x2f]*[@-~]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}

/**
 * The tail of the log, cleaned and capped.
 *
 * 🔴 **The TAIL, never the head.** Every build tool in this stack prints its banner first and its
 * errors last — `npm` echoes the script, `tsc` lists diagnostics then `Found N errors`, Vite prints
 * `error during build:` at the end. Capping from the front would reliably show the user the npm
 * preamble and cut off the only part that matters, which is a worse failure than showing nothing at
 * all: it looks like an answer.
 */
function tailOf(text: string): string | undefined {
  const cleaned = stripAnsi(text).replace(/\r\n/g, '\n').trim();

  if (cleaned === '') {
    /*
     * An empty `<pre>` is worse than no panel — it reads as "the error is blank" rather than "the
     * build told us nothing", and it takes up the space where an explanation should be.
     */
    return undefined;
  }

  if (cleaned.length <= MAX_BUILD_DETAIL_CHARS) {
    return cleaned;
  }

  return `${TRUNCATION_NOTICE}\n\n${cleaned.slice(-MAX_BUILD_DETAIL_CHARS).trimStart()}`;
}

/**
 * The first line that looks like an error, for the headline.
 *
 * ⚠️ Deliberately a WEAK match on a word, not a parse of any tool's diagnostic format. A per-tool
 * parser is the kind that silently returns nothing the day a tool changes its wording, and the whole
 * point of this module is to stop failing silently. When this finds nothing the caller still shows the
 * full log, so the cost of a miss is a generic sentence above a complete answer — never a lost one.
 */
function headlineFrom(cleaned: string): string | undefined {
  for (const raw of cleaned.split('\n')) {
    const line = raw.trim();

    /*
     * `> tsc -b && vite build` is the npm script echo. It contains no error and matching it would put
     * the COMMAND in the headline on every single failure, which is the one line guaranteed to be
     * useless.
     */
    if (line === '' || line.startsWith('>')) {
      continue;
    }

    if (/\berrors?\b/i.test(line) && !/^found \d+ errors?\.?$/i.test(line)) {
      return line.length > 200 ? `${line.slice(0, 199)}…` : line;
    }
  }

  return undefined;
}

/**
 * What to tell someone whose publish just failed.
 *
 * The contract the callers rely on: `message` is always a complete sentence safe to show alone, and
 * `detail` is additive — never the only place the reason appears in a form a user can understand.
 */
export function describeBuildFailure({ exitCode, output, stalledReason }: BuildFailureInput): BuildFailure {
  const detail = tailOf(output);

  /*
   * A stall wins the headline outright. "Your code does not compile" and "the sandbox stopped
   * answering" call for completely different actions, and the log of a stalled build is a fragment
   * that will happily look like a compile error if we let it write the sentence.
   *
   * Its partial output still travels as detail: it is the only evidence of how far the build got.
   */
  if (stalledReason) {
    return { message: stalledReason, detail };
  }

  const headline = detail === undefined ? undefined : headlineFrom(detail);

  return {
    message: headline ?? GENERIC_BUILD_FAILURE,

    /*
     * `exitCode` is reported only when there is nothing else — a bare number is not an explanation,
     * but "exit code 2" beats a sentence that names no cause at all when the build printed nothing.
     */
    detail: detail ?? (exitCode === 0 ? undefined : `The build exited with code ${exitCode} and produced no output.`),
  };
}
