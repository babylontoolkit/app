/**
 * The OSC scanner (`app/utils/shell.ts`).
 *
 * 🔴 This exists because reading only the FIRST control message in a stream chunk hangs every shell
 * command in the product — `npm install` on mount and every `<boltAction type="shell">` the model
 * emits — silently and forever. The bytes in `MEASURED_PROMPT_CHUNK` are a real capture from a
 * CodeSandbox PTY, not a construction: a single bash `PROMPT_COMMAND` emits the exit report and the
 * prompt marker back to back, so they arrive together, and `executeCommand` opens by waiting for the
 * SECOND one.
 *
 * Everything here asserts on ONE `scanOscSignals` call, deliberately — the defect it replaces was a
 * composition bug (the regex was right, the shim was right, the pair was wrong), and a test that
 * concatenates several scans before asserting cannot see that class of failure. Same discipline as
 * `shell-strip.spec.ts`.
 */
import { describe, expect, it } from 'vitest';
import { scanOscSignals } from './shell';

/** Captured live from `bash` in a CodeSandbox VM. Do not "tidy" it — its shape IS the regression. */
const MEASURED_PROMPT_CHUNK = '\x1b]654;exit=0:0\x07\x1b]654;prompt\x07\x1b[?2004hroot@f4s3lp:/project/workspace# ';

/** Captured live after `echo HELLO` — the command's output and both markers in one write. */
const MEASURED_COMMAND_CHUNK = 'echo HELLO\r\n\x1b[?2004l\rHELLO\r\n\x1b]654;exit=0:0\x07\x1b]654;prompt\x07';

describe('scanOscSignals', () => {
  it('returns EVERY signal in a chunk, in order — the regression that hung every shell command', () => {
    const { signals } = scanOscSignals(MEASURED_PROMPT_CHUNK);

    expect(signals).toEqual([{ code: 'exit', exitCode: 0 }, { code: 'prompt' }]);
  });

  it('finds `prompt` when it shares a chunk with an exit report', () => {
    // The exact question `waitTillOscCode('prompt')` asks. A first-match-only reader answers "no".
    expect(scanOscSignals(MEASURED_PROMPT_CHUNK).signals.some((s) => s.code === 'prompt')).toBe(true);
  });

  it('finds both markers behind real command output', () => {
    expect(scanOscSignals(MEASURED_COMMAND_CHUNK).signals).toEqual([{ code: 'exit', exitCode: 0 }, { code: 'prompt' }]);
  });

  it('reports a non-zero exit status', () => {
    expect(scanOscSignals('\x1b]654;exit=0:1\x07\x1b]654;prompt\x07').signals[0]).toEqual({
      code: 'exit',
      exitCode: 1,
    });
  });

  it('reads WebContainer’s readiness marker, which carries no status', () => {
    expect(scanOscSignals('\x1b]654;interactive\x07').signals).toEqual([{ code: 'interactive' }]);
  });

  it('ignores ordinary output and ANSI colour codes', () => {
    expect(scanOscSignals('\x1b[32madded 214 packages\x1b[0m\r\n').signals).toEqual([]);
  });

  describe('sequences split across chunks', () => {
    it('carries a partial sequence and completes it on the next chunk', () => {
      const whole = '\x1b]654;exit=0:0\x07\x1b]654;prompt\x07';

      for (let cut = 1; cut < whole.length; cut++) {
        const first = scanOscSignals(whole.slice(0, cut));
        const second = scanOscSignals(first.rest + whole.slice(cut));

        expect(
          [...first.signals, ...second.signals],
          `a PTY split at byte ${cut} must still yield both signals`,
        ).toEqual([{ code: 'exit', exitCode: 0 }, { code: 'prompt' }]);
      }
    });

    it('retains only the trailing partial, never a completed sequence', () => {
      expect(scanOscSignals('\x1b]654;prompt\x07\x1b]654;ex').rest).toBe('\x1b]654;ex');
    });

    it('retains a bare escape that could still open a sequence', () => {
      expect(scanOscSignals('done\x1b').rest).toBe('\x1b');
    });

    it('carries nothing when the tail cannot become a sequence', () => {
      // An unbounded carry is the other way this loop wedges — on memory rather than on a wait.
      expect(scanOscSignals('\x1b[32mplain coloured output\x1b[0m').rest).toBe('');
    });

    it('drops an over-long candidate rather than growing without bound', () => {
      const runaway = `\x1b]654;${'x'.repeat(200)}`;

      expect(scanOscSignals(runaway).rest).toBe('');
    });

    it('terminates on a short tail whose escape sits at position 0 — the loop that froze the tab', () => {
      /*
       * 🔴 `lastIndexOf('\x1b', -1)` CLAMPS to 0, so an escape at position 0 was found forever and
       * the UI thread spun at 100% CPU. These are the bytes of every bash prompt redraw once the OSC
       * signals are consumed — i.e. the first `npm install` of every creation froze the product.
       * MEASURED live before the fix: renderer pinned, generation finished server-side with "the
       * client did not save this turn". If this test hangs, that bug is back.
       */
      expect(
        scanOscSignals('\x1b]654;exit=0:0\x07\x1b]654;prompt\x07\x1b[?2004hroot@sbx:/project/workspace# ').rest,
      ).toBe('');

      // A tail that IS a partial opener at position 0 must still be carried, not dropped.
      expect(scanOscSignals('\x1b]654;pro').rest).toBe('\x1b]654;pro');
    });
  });

  it('keeps no state between calls (a shared global regex would skip the second command)', () => {
    const once = scanOscSignals(MEASURED_PROMPT_CHUNK).signals;

    expect(scanOscSignals(MEASURED_PROMPT_CHUNK).signals).toEqual(once);
  });
});
