/**
 * The rules that turn a failed share build into something a user can act on.
 *
 * Every assertion here stands in for a way the previous behaviour failed SILENTLY — it produced a
 * confident, complete-looking sentence that named nothing, so the only conclusion available to the
 * user was that the Share button itself was broken.
 */
import { describe, expect, it } from 'vitest';
import {
  describeBuildFailure,
  stripAnsi,
  GENERIC_BUILD_FAILURE,
  MAX_BUILD_DETAIL_CHARS,
  TRUNCATION_NOTICE,
} from './build-failure';

const ESC = '\u001b';

/** The exact log captured from a live failing share build on 2026-08-01 (Nodepod, `npm run build`). */
const REAL_TSC_LOG =
  '\n> top-down-twin-stick@0.0.1 build\n> tsc -b && vite build --base=./\n\n' +
  `${ESC}[96msrc/scripts/TopDownTwinStickMode.ts${ESC}[0m:${ESC}[93m87${ESC}[0m:${ESC}[93m14${ESC}[0m - ` +
  `${ESC}[91merror${ESC}[0m${ESC}[90m TS2339: ${ESC}[0mProperty 'hideSplashScreenDelayMs' does not exist on ` +
  "type 'TopDownTwinStickMode'.\n\n" +
  `${ESC}[7m87${ESC}[0m         this.hideSplashScreenDelayMs = 900;\n` +
  `${ESC}[7m  ${ESC}[0m ${ESC}[91m             ~~~~~~~~~~~~~~~~~~~~~~~${ESC}[0m\n\n\nFound 1 error.\n\n`;

describe('stripAnsi', () => {
  it('removes the colour codes a TTY build writes', () => {
    expect(stripAnsi(`${ESC}[91merror${ESC}[0m`)).toBe('error');
  });

  /*
   * The control character is the whole safety of the pattern. Without it the class matches any
   * bracketed word, and these two strings are both REAL build output — a Vite resolve failure and a
   * tsc code frame.
   */
  it('leaves bracketed text that is not an escape sequence exactly as it was', () => {
    expect(stripAnsi('[vite]: Rollup failed to resolve import "foo"')).toBe(
      '[vite]: Rollup failed to resolve import "foo"',
    );
    expect(stripAnsi('const x = arr[0];')).toBe('const x = arr[0];');
    expect(stripAnsi('type T = Array<string>[];')).toBe('type T = Array<string>[];');
  });

  it('leaves ordinary text untouched', () => {
    expect(stripAnsi('Found 1 error.')).toBe('Found 1 error.');
  });
});

describe('describeBuildFailure', () => {
  it('names the file, line and reason from a real tsc failure', () => {
    const { message, detail } = describeBuildFailure({ exitCode: 2, output: REAL_TSC_LOG });

    /*
     * The point of the whole module: the user must be able to read the failing FILE off the message
     * without opening anything.
     */
    expect(message).toContain('src/scripts/TopDownTwinStickMode.ts');
    expect(message).toContain('87');
    expect(message).toContain('hideSplashScreenDelayMs');
    expect(message).not.toBe(GENERIC_BUILD_FAILURE);

    expect(detail).toContain('Found 1 error.');
  });

  it('never leaks an escape sequence into what is rendered', () => {
    const { message, detail } = describeBuildFailure({ exitCode: 2, output: REAL_TSC_LOG });

    expect(message).not.toContain(ESC);
    expect(detail).not.toContain(ESC);
  });

  /*
   * ⚠️ The obvious version of this test — run the real log and assert the headline is not the echo —
   * PASSES with the guard removed, because neither of that log's `>` lines happens to contain the
   * word "error". It asserted nothing. The echo is whatever the project's package.json says, so it
   * takes a script that does contain the word to exercise the rule at all.
   */
  it('does not put the npm script echo in the headline', () => {
    const output =
      '\n> game@0.0.1 build\n> tsc -b || echo "build error"\n\nsrc/a.ts:3:9 - error TS2304: Cannot find name.\n';

    const { message } = describeBuildFailure({ exitCode: 2, output });

    expect(message).not.toContain('echo');
    expect(message).toContain('src/a.ts');
  });

  it('does not headline the summary count, which names no cause', () => {
    const { message } = describeBuildFailure({ exitCode: 2, output: 'Found 3 errors.\n' });

    expect(message).toBe(GENERIC_BUILD_FAILURE);
  });

  it('falls back to a complete sentence when the log matches nothing', () => {
    const { message, detail } = describeBuildFailure({ exitCode: 1, output: 'something went sideways' });

    expect(message).toBe(GENERIC_BUILD_FAILURE);

    // The fallback must still carry the log — a generic sentence ALONE is the bug being fixed.
    expect(detail).toBe('something went sideways');
  });

  it('reports the exit code when the build printed nothing at all', () => {
    const { message, detail } = describeBuildFailure({ exitCode: 137, output: '' });

    expect(message).toBe(GENERIC_BUILD_FAILURE);
    expect(detail).toContain('137');
  });

  it('shows no empty panel when there is nothing to show', () => {
    // An empty <pre> reads as "the error is blank" rather than "the build said nothing".
    expect(describeBuildFailure({ exitCode: 0, output: '   \n\n  ' }).detail).toBeUndefined();
  });

  describe('a stalled build', () => {
    it('keeps its own explanation instead of inventing a compile error', () => {
      const { message } = describeBuildFailure({
        exitCode: 1,
        output: 'error: could not reach the sandbox',
        stalledReason: 'The build stopped responding.',
      });

      expect(message).toBe('The build stopped responding.');
    });

    it('still carries whatever output it managed to produce', () => {
      // The partial log is the only evidence of how far a stalled build got.
      const { detail } = describeBuildFailure({
        exitCode: 1,
        output: 'vite v8.2.0 building for production...',
        stalledReason: 'The build stopped responding.',
      });

      expect(detail).toContain('vite v8.2.0');
    });
  });

  describe('a very long log', () => {
    const long = `${'noise\n'.repeat(4_000)}src/game.ts:1:1 - error TS1005: ';' expected.\nFound 1 error.`;

    it('keeps the END, where every tool in this stack puts its errors', () => {
      const { detail } = describeBuildFailure({ exitCode: 2, output: long });

      /*
       * 🔴 The direction of the cut is the correctness. Capping from the front would reliably show
       * the npm banner and drop the only actionable line — a wrong answer that looks like an answer.
       */
      expect(detail).toContain('error TS1005');
      expect(detail).toContain('Found 1 error.');
    });

    it('stays within the cap and says that it cut', () => {
      const { detail } = describeBuildFailure({ exitCode: 2, output: long });

      expect(detail!.length).toBeLessThanOrEqual(MAX_BUILD_DETAIL_CHARS + TRUNCATION_NOTICE.length + 2);
      expect(detail).toContain(TRUNCATION_NOTICE);
    });

    it('does not claim to have cut a log that fits', () => {
      const { detail } = describeBuildFailure({ exitCode: 2, output: 'short and complete' });

      expect(detail).not.toContain(TRUNCATION_NOTICE);
    });

    it('still finds a headline in a log it had to cut', () => {
      const { message } = describeBuildFailure({ exitCode: 2, output: long });

      expect(message).toContain('error TS1005');
    });
  });

  it('always returns a message, for any input', () => {
    // This text goes straight into a toast; an empty or undefined one is a failure with no words.
    for (const output of ['', '\n', 'x', REAL_TSC_LOG, 'error', '>'.repeat(500)]) {
      for (const exitCode of [0, 1, 2, 137]) {
        const { message } = describeBuildFailure({ exitCode, output });
        expect(message.trim().length).toBeGreaterThan(0);
      }
    }
  });

  /*
   * ⚠️ The line must stay UNDER the detail cap to test this. A 5,000-char line is truncated by
   * `tailOf` first, and the surviving tail no longer contains the word "error" — so the headline
   * falls back to the generic sentence and the assertion passes with the cap removed. The first
   * draft did exactly that and verified nothing.
   */
  it('caps the headline so one enormous line cannot become the toast', () => {
    const line = `error TS2345: ${'x'.repeat(1_000)}`;

    expect(line.length).toBeLessThan(MAX_BUILD_DETAIL_CHARS);

    const { message, detail } = describeBuildFailure({ exitCode: 2, output: line });

    expect(message.length).toBeLessThanOrEqual(200);

    // Capping the headline must not cap the log — the full line is still readable below it.
    expect(detail).toBe(line);
  });
});
