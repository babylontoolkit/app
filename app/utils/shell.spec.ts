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
import { describe, expect, it, vi } from 'vitest';
import { BoltShell, reduceOscSignals, scanOscSignals, type OscWaitState } from './shell';

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

/**
 * The stale-marker accounting (MEASURED live, 2026-07-27). bash's PROMPT_COMMAND fires on prompt
 * draws that follow NO command — attach, and Ctrl-C at an idle prompt — so their exit/prompt markers
 * sit buffered and the next wait matches them. On a real creation: `npm install` "completed"
 * instantly against a stale exit 0, the chain moved to `npm run dev`, whose leading interrupt KILLED
 * the still-running install, and the start action then "failed" (stale 130) over a healthy server.
 * `afterOsc` (bash's PS0 begin marker) arms the wait so pre-begin signals can never satisfy it.
 */
describe('reduceOscSignals — stale markers must never satisfy a wait', () => {
  const START: OscWaitState = { armed: false, exitCode: 0, done: false };

  it('the measured kill, as a test: stale exits before the begin marker are ignored', () => {
    // Attach pair + Ctrl-C pair, buffered before our command ever ran.
    const stale = [
      { code: 'exit', exitCode: 0 },
      { code: 'prompt' },
      { code: 'exit', exitCode: 130 },
      { code: 'prompt' },
    ];

    const afterStale = reduceOscSignals(START, stale, 'exit', 'begin');
    expect(afterStale.done).toBe(false); // npm install must NOT "complete" off these
    expect(afterStale.exitCode).toBe(0); // and the stale 130 is not recorded either

    // Our command starts (PS0) and later really exits.
    const armed = reduceOscSignals(afterStale, [{ code: 'begin' }], 'exit', 'begin');
    expect(armed.armed).toBe(true);
    expect(armed.done).toBe(false); // the begin itself satisfies nothing

    const finished = reduceOscSignals(armed, [{ code: 'exit', exitCode: 2 }], 'exit', 'begin');
    expect(finished).toMatchObject({ done: true, exitCode: 2 });
  });

  it('without a begin marker the state starts armed — the jsh path, byte-identical to before', () => {
    const state = reduceOscSignals(
      { armed: true, exitCode: 0, done: false },
      [{ code: 'exit', exitCode: 7 }, { code: 'prompt' }],
      'exit',
      undefined,
    );

    expect(state).toMatchObject({ done: true, exitCode: 7 });
  });

  it('arming survives across chunks — a begin in one chunk arms the exit in a later one', () => {
    const armed = reduceOscSignals(START, [{ code: 'begin' }], 'exit', 'begin');
    const finished = reduceOscSignals(armed, [{ code: 'exit', exitCode: 0 }], 'exit', 'begin');

    expect(finished.done).toBe(true);
  });

  it('records the exit status even when the SAME signal ends the wait (waitCode === exit)', () => {
    const finished = reduceOscSignals(
      { armed: true, exitCode: 0, done: false },
      [{ code: 'exit', exitCode: 130 }],
      'exit',
      undefined,
    );

    expect(finished.exitCode).toBe(130);
  });

  it('a prompt wait is satisfied by a prompt only, never by an exit', () => {
    const state = reduceOscSignals(
      { armed: true, exitCode: 0, done: false },
      [{ code: 'exit', exitCode: 1 }],
      'prompt',
      undefined,
    );

    expect(state.done).toBe(false);
    expect(reduceOscSignals(state, [{ code: 'prompt' }], 'prompt', undefined).done).toBe(true);
  });
});

/**
 * The demultiplexer (`BoltShell.waitTillOscCode` + the pump).
 *
 * 🔴 **Two waits genuinely coexist.** `executeCommand` interrupts and waits for `prompt` while a
 * parked start action is still waiting for `exit`. Each used to run its OWN read loop over the SAME
 * reader, and a `read()` hands a chunk to exactly one of them — so when bash emits `exit`+`prompt`
 * in a single chunk (`MEASURED_PROMPT_CHUNK`, the Ctrl-C shape), whichever loop received it consumed
 * BOTH signals and the other starved forever. Nothing threw; the live creations only worked because
 * stale attach-draw markers happened to backfill the loser, a balance that depends on where the PTY
 * chose to split its writes.
 *
 * Every assertion here is BOUNDED rather than a bare `await`: a regression in this file's subject is
 * a HANG, and a hung suite reports nothing.
 */
describe('BoltShell — one reader, every signal routed to every wait', () => {
  /** The measured Ctrl-C shape with a chosen status, so a starved wait cannot pass by luck. */
  const ctrlCChunk = (code: number) =>
    `\x1b]654;exit=0:${code}\x07\x1b]654;prompt\x07\x1b[?2004hroot@f4s3lp:/project/workspace# `;

  function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;

    return Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} starved — it never resolved`)), 1000);
      }),
    ]).finally(() => clearTimeout(timer)) as Promise<T>;
  }

  function harness(shellDecl: { readyOsc?: string; beginOsc?: string }) {
    let push!: (chunk: string) => void;
    let close!: () => void;
    let fail!: (error: Error) => void;

    const output = new ReadableStream<string>({
      start(controller) {
        push = (chunk) => controller.enqueue(chunk);
        close = () => controller.close();
        fail = (error) => controller.error(error);
      },
    });

    const process = {
      // A PTY outlives any one command, so its exit never settles — same as the real adapters.
      exit: new Promise<number>(vi.fn()),
      input: new WritableStream<string>({ write: vi.fn() }),
      output,
      kill: vi.fn(),
      resize: vi.fn(),
    };

    const sandbox = {
      shell: { command: 'bash', args: [] as string[], ...shellDecl },
      spawn: async () => process,
    };

    const terminal = { cols: 80, rows: 24, onData: vi.fn(), input: vi.fn(), write: vi.fn() };

    const shell = new BoltShell();
    const ready = shell.init(sandbox as never, terminal as never);

    return { shell, push, close, fail, ready };
  }

  /** A bash-like shell: no readiness marker (ready on first output), PS0 `begin` declared. */
  async function bashShell() {
    const h = harness({ beginOsc: 'begin' });
    h.push('root@f4s3lp:/project/workspace# ');
    await bounded(h.ready, 'init');

    return h;
  }

  it('one chunk carrying exit+prompt satisfies BOTH waits — neither starves', async () => {
    const h = await bashShell();

    // The parked start action, and then `executeCommand`'s interrupt wait.
    const exitWait = h.shell.waitTillOscCode('exit', 'begin');
    const promptWait = h.shell.waitTillOscCode('prompt');

    h.push('\x1b]654;begin\x07'); // our command really started (PS0) — arms the exit wait
    h.push(ctrlCChunk(130)); // ONE chunk, both signals

    await expect(bounded(promptWait, 'the prompt wait')).resolves.toBeDefined();
    expect((await bounded(exitWait, 'the exit wait')).exitCode).toBe(130);
  });

  it('the same, with the waits registered in the OTHER order', async () => {
    // Order must not decide who eats the chunk — that was the whole defect, in one direction.
    const h = await bashShell();

    const promptWait = h.shell.waitTillOscCode('prompt');
    const exitWait = h.shell.waitTillOscCode('exit', 'begin');

    h.push('\x1b]654;begin\x07');
    h.push(ctrlCChunk(7));

    await expect(bounded(promptWait, 'the prompt wait')).resolves.toBeDefined();
    expect((await bounded(exitWait, 'the exit wait')).exitCode).toBe(7);
  });

  it('a sequence SPLIT across two chunks still reaches both waits (the carry lives on the pump)', async () => {
    const h = await bashShell();

    const exitWait = h.shell.waitTillOscCode('exit', 'begin');
    const promptWait = h.shell.waitTillOscCode('prompt');

    h.push('\x1b]654;begin\x07');
    h.push('\x1b]654;ex'); // a PTY splits its writes wherever it likes
    h.push('it=0:5\x07\x1b]654;prompt\x07');

    await expect(bounded(promptWait, 'the prompt wait')).resolves.toBeDefined();
    expect((await bounded(exitWait, 'the exit wait')).exitCode).toBe(5);
  });

  it('the carry survives a boundary that falls BETWEEN two waits', async () => {
    /*
     * The pump stops when nothing is waiting. A per-wait carry could not see this case at all: the
     * partial arrives on the wait that is about to resolve, and the wait that completes it has not
     * been registered yet.
     */
    const h = await bashShell();

    const promptWait = h.shell.waitTillOscCode('prompt');
    h.push('\x1b]654;begin\x07\x1b]654;prompt\x07\x1b]654;ex');
    await bounded(promptWait, 'the prompt wait');

    const exitWait = h.shell.waitTillOscCode('exit');
    h.push('it=0:9\x07');

    expect((await bounded(exitWait, 'the exit wait')).exitCode).toBe(9);
  });

  it('a stream ERROR REJECTS every pending wait — fail loud, at the call site that was waiting', async () => {
    /*
     * 🔴 Before the demultiplexer, `read()` was awaited inside the CALLER's promise, so a stream
     * error rejected the caller. With one shared loop the rejection has nowhere to go: it escaped as
     * an unhandled rejection while every wait parked forever — a loud failure turned silent and
     * permanent. The pump catches it and hands it to the waits instead.
     */
    const h = await bashShell();

    const exitWait = h.shell.waitTillOscCode('exit', 'begin');
    const promptWait = h.shell.waitTillOscCode('prompt');

    h.fail(new Error('the PTY vanished'));

    await expect(bounded(exitWait, 'the exit wait')).rejects.toThrow('the PTY vanished');
    await expect(bounded(promptWait, 'the prompt wait')).rejects.toThrow('the PTY vanished');
  });

  it('a wait registered AFTER the stream errored still rejects rather than parking', async () => {
    const h = await bashShell();

    h.fail(new Error('the PTY vanished'));

    // The pump restarts for the new waiter, hits the same error, and answers it.
    await expect(bounded(h.shell.waitTillOscCode('exit'), 'a late wait')).rejects.toThrow('the PTY vanished');
  });

  it('the pump’s own promise swallows nothing — no unhandled rejection escapes it', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);

    try {
      const h = await bashShell();
      const wait = h.shell.waitTillOscCode('exit', 'begin');

      h.fail(new Error('the PTY vanished'));
      await expect(bounded(wait, 'the exit wait')).rejects.toThrow('the PTY vanished');

      // Unhandled rejections are reported a macrotask later; give the loop a turn to report one.
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(unhandled.map(String)).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('EVERY wait resolves when the shell dies — a dead shell must not leave a wait parked', async () => {
    const h = await bashShell();

    const exitWait = h.shell.waitTillOscCode('exit', 'begin');
    const promptWait = h.shell.waitTillOscCode('prompt');

    h.close();

    await expect(bounded(exitWait, 'the exit wait')).resolves.toBeDefined();
    await expect(bounded(promptWait, 'the prompt wait')).resolves.toBeDefined();
  });

  describe('the jsh / WebContainer path is unchanged', () => {
    /** jsh declares a readiness marker and NO begin marker — waits start armed, as before. */
    async function jshShell() {
      const h = harness({ readyOsc: 'interactive' });
      h.push('\x1b]654;interactive\x07');
      await bounded(h.ready, 'init');

      return h;
    }

    it('readiness still gates init on the `interactive` marker', async () => {
      await expect(jshShell()).resolves.toBeDefined();
    });

    it('an exit wait with no begin marker starts ARMED and resolves off the measured chunk', async () => {
      const h = await jshShell();

      const exitWait = h.shell.waitTillOscCode('exit'); // `beginOsc` is undefined on this path
      h.push(MEASURED_PROMPT_CHUNK);

      expect((await bounded(exitWait, 'the exit wait')).exitCode).toBe(0);
    });

    it('and a coexisting prompt wait is satisfied by the same chunk', async () => {
      const h = await jshShell();

      const exitWait = h.shell.waitTillOscCode('exit');
      const promptWait = h.shell.waitTillOscCode('prompt');
      h.push(MEASURED_COMMAND_CHUNK);

      await expect(bounded(promptWait, 'the prompt wait')).resolves.toBeDefined();
      await expect(bounded(exitWait, 'the exit wait')).resolves.toBeDefined();
    });
  });
});
