import type { SandboxProcess, SandboxProvider } from '~/lib/sandbox';
import type { ITerminal } from '~/types/terminal';
import { withResolvers } from './promises';
import { atom } from 'nanostores';
import { expoUrlAtom } from '~/lib/stores/qrCodeStore';

export async function newShellProcess(sandbox: SandboxProvider, terminal: ITerminal) {
  /*
   * The shell comes from the PROVIDER (`spec/sandbox-seam.md`). `/bin/jsh --osc` is WebContainer's
   * own shell and does not exist on a real container — hardcoding it made a server-backed terminal
   * open and immediately print `bash: /bin/jsh: No such file or directory`.
   */
  const process = await sandbox.spawn(sandbox.shell.command, [...sandbox.shell.args], {
    env: sandbox.shell.env,
    terminal: {
      cols: terminal.cols ?? 80,
      rows: terminal.rows ?? 15,
    },
  });

  const input = process.input.getWriter();
  const output = process.output;

  const jshReady = withResolvers<void>();

  /*
   * A shell with no readiness marker is ready as soon as it speaks. Waiting for an OSC that a real
   * bash never sends would hang the terminal forever, silently — which is why `readyOsc` is
   * optional rather than a value every provider has to invent.
   */
  const readyOsc = sandbox.shell.readyOsc;

  let isInteractive = false;
  output
    .pipeTo(
      new WritableStream({
        write(data) {
          if (!isInteractive) {
            // Every signal in the chunk — a readiness marker can share one write with an exit report.
            if (!readyOsc || scanOscSignals(data).signals.some((signal) => signal.code === readyOsc)) {
              isInteractive = true;
              jshReady.resolve();
            }
          }

          terminal.write(data);

          // Capture terminal output for debugging
          try {
            import('~/utils/debugLogger')
              .then(({ captureTerminalLog }) => {
                // Clean the data by removing ANSI escape sequences for logging
                const cleanData = data.replace(/\x1b\[[0-9;]*[mG]/g, '').trim();

                if (cleanData) {
                  captureTerminalLog(cleanData, 'output');
                }
              })
              .catch(() => {
                // Ignore if debug logger is not available
              });
          } catch {
            // Ignore errors in debug logging
          }
        },
      }),
    )
    .catch(() => {
      // Same reason as `newBoltShellProcess`: a floating pipe must not leak an unhandled rejection.
    });

  terminal.onData((data) => {
    // console.log('terminal onData', { data, isInteractive });

    if (isInteractive) {
      input.write(data);

      // Capture terminal input for debugging
      try {
        import('~/utils/debugLogger')
          .then(({ captureTerminalLog }) => {
            // Clean the data and check if it's a command (not just cursor movement)
            const cleanData = data.replace(/\x1b\[[0-9;]*[A-Z]/g, '').trim();

            if (cleanData && cleanData !== '\r' && cleanData !== '\n') {
              captureTerminalLog(cleanData, 'input');
            }
          })
          .catch(() => {
            // Ignore if debug logger is not available
          });
      } catch {
        // Ignore errors in debug logging
      }
    }
  });

  await jshReady.promise;

  return process;
}

export type ExecutionResult = { output: string; exitCode: number } | undefined;

/** Running state for one OSC wait — see {@link reduceOscSignals}. */
export interface OscWaitState {
  /** May exit markers be trusted yet? Starts false only when a begin marker is required. */
  armed: boolean;

  /** The last exit code recorded from a TRUSTED exit marker. */
  exitCode: number;

  /** The wait is satisfied. */
  done: boolean;
}

/**
 * Fold one chunk's OSC signals into a wait's state — the accounting half of `waitTillOscCode`,
 * pure so the stale-marker rules can be pinned by tests.
 *
 * 🔴 **Why arming exists (MEASURED live on CodeSandbox, 2026-07-27):** bash's `PROMPT_COMMAND`
 * emits `exit`+`prompt` markers on prompt draws that follow NO command — the initial draw at
 * attach, and Ctrl-C at an idle prompt. Nothing consumes those, so they sit buffered in the stream
 * and the NEXT wait matches them: the creation's `npm install` "completed" instantly against a
 * stale exit 0, the action chain moved on to `npm run dev`, and its leading interrupt KILLED the
 * still-running install — then the start action "failed" with the install's stale 130 over a dev
 * server that was actually up. When the shell declares a `beginOsc` (bash's `PS0`, expanded only
 * when a typed command actually starts), every signal BEFORE that marker is stale by construction
 * and ignored. jsh declares none, so `afterOsc` is undefined there and the state starts armed —
 * byte-identical behaviour to before.
 */
export function reduceOscSignals(
  state: OscWaitState,
  signals: readonly OscSignal[],
  waitCode: string,
  afterOsc?: string,
): OscWaitState {
  let { armed, exitCode, done } = state;

  for (const signal of signals) {
    if (!armed) {
      if (afterOsc !== undefined && signal.code === afterOsc) {
        armed = true;
      }

      // Everything before the begin marker is a previous command's leftovers — never ours.
      continue;
    }

    if (signal.code === 'exit' && signal.exitCode !== undefined) {
      exitCode = signal.exitCode;
    }

    /*
     * No early `break` on the exit code above: the status must be recorded BEFORE we stop, and
     * when `waitCode` is `exit` the very same signal both sets it and ends the wait.
     */
    if (signal.code === waitCode) {
      done = true;
      break;
    }
  }

  return { armed, exitCode, done };
}

/** One `\x1b]654;…\x07` control message from the shell. */
export interface OscSignal {
  /** The payload before any `=` — `prompt`, `exit`, `interactive`. */
  code: string;

  /** Present only on `exit=0:<n>`. */
  exitCode?: number;
}

const OSC_PREFIX = '\x1b]654;';

/*
 * Deliberately GLOBAL, and constructed fresh per scan rather than shared: a global regex carries
 * `lastIndex` between calls, which is exactly the kind of hidden state that makes a parser work in a
 * test and fail on the second command.
 */
const OSC_PATTERN = /\x1b\]654;([^\x07=]+)=?((-?\d+):(\d+))?\x07/g;

/**
 * The longest partial sequence worth carrying. A real one is ~20 bytes; anything longer is not an OSC
 * that got split, it is ordinary output that happens to start with an escape — and carrying it
 * forever would grow the buffer without bound.
 */
const MAX_PARTIAL_OSC = 64;

/**
 * Every OSC control message in `input`, in order, plus the trailing bytes that might still become one.
 *
 * 🔴 **Reading only the FIRST match hangs every shell command, silently and forever.** `executeCommand`
 * opens by waiting for `prompt`, and a real bash emits `exit=0:<n>` and `prompt` from a single
 * `PROMPT_COMMAND` — so they arrive in ONE stream chunk (MEASURED on CodeSandbox:
 * `\x1b]654;exit=0:0\x07\x1b]654;prompt\x07\x1b[?2004hroot@…#`). A non-global `String.match` returns
 * `exit`, the wait for `prompt` never matches, and nothing throws: `npm install` on mount and every
 * `<boltAction type="shell">` the model emits just never start. That is the product.
 *
 * The `rest` return is the other half. A PTY splits writes wherever it likes, so a sequence can
 * straddle a chunk boundary; dropping the tail loses that signal and hangs the same way, one time in
 * however-many. Only bytes that could still COMPLETE into a sequence are retained — a prefix of
 * `\x1b]654;`, or a started sequence still missing its `\x07` — and only up to {@link MAX_PARTIAL_OSC}.
 *
 * Pure and exported so it can be tested against real captured bytes, which is the only way this class
 * of defect gets caught: the shim reads correctly, the regex reads correctly, and the composition is
 * wrong.
 */
export function scanOscSignals(input: string): { signals: OscSignal[]; rest: string } {
  const signals: OscSignal[] = [];
  const pattern = new RegExp(OSC_PATTERN.source, 'g');

  let consumed = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(input)) !== null) {
    const code = match[1];
    const exitCode = match[4] === undefined ? undefined : parseInt(match[4], 10);

    signals.push(exitCode === undefined ? { code } : { code, exitCode });
    consumed = pattern.lastIndex;
  }

  return { signals, rest: retainPartialOsc(input.slice(consumed)) };
}

function retainPartialOsc(tail: string): string {
  /*
   * 🔴 The `at === 0 ? -1 : …` is load-bearing, and its absence FROZE THE PRODUCT: `lastIndexOf`
   * CLAMPS a negative fromIndex to 0, so `tail.lastIndexOf('\x1b', -1)` finds an escape sitting at
   * position 0 again and again — an infinite loop ON THE UI THREAD. The bytes that trigger it are
   * not exotic; they are every bash prompt redraw (`\x1b[?2004h<prompt>` after the OSC signals are
   * consumed), so the first `npm install` of every creation pinned the tab at 100% CPU forever
   * (MEASURED live: renderer at 101% CPU, a no-op evaluate timing out, the generation finishing
   * server-side with "the client did not save this turn").
   */
  for (let at = tail.lastIndexOf('\x1b'); at !== -1; at = at === 0 ? -1 : tail.lastIndexOf('\x1b', at - 1)) {
    const candidate = tail.slice(at);

    if (candidate.length > MAX_PARTIAL_OSC) {
      return '';
    }

    // Either a started sequence still awaiting its terminator, or a prefix of the opener.
    if (candidate.startsWith(OSC_PREFIX) || OSC_PREFIX.startsWith(candidate)) {
      return candidate;
    }
  }

  return '';
}

/**
 * One registered OSC wait, as the demultiplexer sees it.
 *
 * The state machine is `reduceOscSignals` (pure, pinned); this is just the bookkeeping around it —
 * what the wait is for, what it has collected, and how to answer it.
 */
/**
 * The error a wait fails with when the shell process dies underneath it.
 *
 * Exported and pure because this string is the ONLY thing the user gets told about a dev server that
 * died — `build-failure.ts`'s lesson: a refusal that names no cause is read as the button being
 * broken. It carries whatever the command had printed before dying, which for a crashed dev server
 * is the crash, and which was previously discarded along with the wait.
 *
 * `-1` means the provider's own `exit` promise rejected, i.e. we could not learn the code. That is a
 * different fact from "exited 0" and must not be printed as one.
 */
export function shellDiedError(code: number, output: string): Error {
  const cause =
    code === -1 ? 'The workspace shell stopped unexpectedly.' : `The workspace shell exited (code ${code}).`;

  const error = new Error(
    `${cause} Any command running in it was stopped.` + (output.trim() ? `\n\n${output.trimEnd()}` : ''),
  );
  error.name = 'ShellDiedError';

  return error;
}

interface OscWaiter {
  waitCode: string;
  afterOsc?: string;
  state: OscWaitState;
  output: string;
  resolve: (result: { output: string; exitCode: number }) => void;

  /** A stream error reaches the CALLER through this — see `#pumpOutput`'s catch. */
  reject: (error: Error) => void;
}

export class BoltShell {
  #initialized: (() => void) | undefined;
  #readyPromise: Promise<void>;
  #sandbox: SandboxProvider | undefined;
  #terminal: ITerminal | undefined;
  #process: SandboxProcess | undefined;
  executionState = atom<
    { sessionId: string; active: boolean; executionPrms?: Promise<any>; abort?: () => void } | undefined
  >();
  #outputStream: ReadableStreamDefaultReader<string> | undefined;

  /**
   * Set once the shell PROCESS has exited. Every later wait fails immediately instead of parking.
   *
   * 🔴 **A DEAD PROCESS IS NOT A CLOSED STREAM, AND ONLY ONE OF THE TWO WAS HANDLED.** `#pumpOutput`
   * covers the stream ending (`done`) and the stream erroring — but on a sandbox whose PTY survives
   * its process, the shell can die with the stream simply going quiet. `read()` then never returns,
   * every registered wait parks forever, and `executeCommand` never settles.
   *
   * MEASURED live 2026-08-03 on a cloned Vite 8 project: `npm run dev` printed `> vite`, the dev
   * server died, and the `start` action sat at `running` — the terminal-window icon, which is the
   * ONLY icon that status draws — with no error, no alert and a blank Preview tab. The action
   * runner's `.then`/`.catch` around `#runStartAction` are both correct and neither could run,
   * because the promise they are attached to never settled. Same silent shape as the execution-queue
   * poisoning: not a wrong answer, no answer.
   */
  #processExit: { code: number } | undefined;
  #shellInputStream: WritableStreamDefaultWriter<string> | undefined;

  /**
   * Every OSC wait currently in flight. See {@link waitTillOscCode} for why there can be more than
   * one, and why they must not each read the stream.
   */
  #waiters = new Set<OscWaiter>();

  /** Only one read loop may exist, or the waiters race again through a second door. */
  #pumping = false;

  /**
   * Bytes from the previous chunk that could still complete into an OSC sequence.
   *
   * On the pump rather than per-wait: a PTY splits its writes wherever it likes, and a signal lost to
   * a chunk boundary hangs a wait exactly as a missed one does — including when the boundary falls
   * between two different waits, which a per-wait carry could not see.
   */
  #oscCarry = '';

  /** Accumulates output only so an `exp://` URL split across chunks still matches. */
  #expoBuffer = '';

  constructor() {
    this.#readyPromise = new Promise((resolve) => {
      this.#initialized = resolve;
    });
  }

  ready() {
    return this.#readyPromise;
  }

  async init(sandbox: SandboxProvider, terminal: ITerminal) {
    this.#sandbox = sandbox;
    this.#terminal = terminal;

    // Use all three streams from tee: one for terminal, one for command execution, one for Expo URL detection
    const { process, commandStream, expoUrlStream } = await this.newBoltShellProcess(sandbox, terminal);
    this.#process = process;
    this.#outputStream = commandStream.getReader();

    /*
     * The shell's own death is a first-class event, not something to infer from silence.
     *
     * Fire-and-forget by design: nothing awaits the shell's lifetime, and a `catch` here is required
     * because a provider whose `exit` REJECTS would otherwise raise an unhandled rejection while
     * leaving every wait parked — the failure this whole block exists to end, arriving by a
     * different door.
     */
    void process.exit.then((code) => this.#onProcessExit(code)).catch(() => this.#onProcessExit(-1));

    /*
     * Start background Expo URL watcher immediately.
     *
     * The `catch` is not decoration: when the PTY stream ERRORS, this loop's `read()` rejects and —
     * being a floating promise — the rejection escapes as an unhandled rejection (a page-level error
     * event in the browser, noise in monitoring). The failure has a proper home now: `#pumpOutput`
     * hands it to every pending wait. A URL watcher has nowhere to report it and nothing to do.
     */
    void this._watchExpoUrlInBackground(expoUrlStream).catch(() => {
      // Nothing to do: the wait that CARES about this failure has already been rejected with it.
    });

    /*
     * Only wait for a readiness marker on a shell that HAS one. `newBoltShellProcess` has already
     * resolved on first output for a marker-less shell, so waiting again here for `'interactive'`
     * would block `ready()` forever on a real bash — and `ready()` gates the action runner, so the
     * symptom is every shell action silently never starting.
     */
    if (sandbox.shell.readyOsc) {
      await this.waitTillOscCode(sandbox.shell.readyOsc);
    }

    this.#initialized?.();
  }

  async newBoltShellProcess(sandbox: SandboxProvider, terminal: ITerminal) {
    // Provider-supplied, for the same reason as `newShellProcess` above.
    const process = await sandbox.spawn(sandbox.shell.command, [...sandbox.shell.args], {
      env: sandbox.shell.env,
      terminal: {
        cols: terminal.cols ?? 80,
        rows: terminal.rows ?? 15,
      },
    });

    const input = process.input.getWriter();
    this.#shellInputStream = input;

    // Tee the output so we can have three independent readers
    const [streamA, streamB] = process.output.tee();
    const [streamC, streamD] = streamB.tee();

    const jshReady = withResolvers<void>();
    const readyOsc = sandbox.shell.readyOsc;
    let isInteractive = false;
    streamA
      .pipeTo(
        new WritableStream({
          write(data) {
            if (!isInteractive) {
              /*
               * No marker (a real PTY) means ready on first output — see `newShellProcess`. Every
               * signal in the chunk, for the reason `scanOscSignals` documents.
               */
              if (!readyOsc || scanOscSignals(data).signals.some((signal) => signal.code === readyOsc)) {
                isInteractive = true;
                jshReady.resolve();
              }
            }

            terminal.write(data);
          },
        }),
      )
      .catch(() => {
        /*
         * A dead PTY stops mirroring to the terminal, which is all this pipe does. Without the catch
         * the rejection is unhandled (the pipe is a floating promise) — and the real failure is
         * already reported where it matters: `#pumpOutput` rejects every pending wait with it.
         */
      });

    terminal.onData((data) => {
      if (isInteractive) {
        input.write(data);
      }
    });

    await jshReady.promise;

    // Return all streams for use in init
    return { process, terminalStream: streamA, commandStream: streamC, expoUrlStream: streamD };
  }

  // Dedicated background watcher for Expo URL
  private async _watchExpoUrlInBackground(stream: ReadableStream<string>) {
    const reader = stream.getReader();
    let buffer = '';
    const expoUrlRegex = /(exp:\/\/[^\s]+)/;

    while (true) {
      const { value, done } = await reader.read();

      if (done) {
        break;
      }

      buffer += value || '';

      const expoUrlMatch = buffer.match(expoUrlRegex);

      if (expoUrlMatch) {
        const cleanUrl = expoUrlMatch[1]
          .replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '')
          .replace(/[^\x20-\x7E]+$/g, '');
        expoUrlAtom.set(cleanUrl);
        buffer = buffer.slice(buffer.indexOf(expoUrlMatch[1]) + expoUrlMatch[1].length);
      }

      if (buffer.length > 2048) {
        buffer = buffer.slice(-2048);
      }
    }
  }

  get terminal() {
    return this.#terminal;
  }

  get process() {
    return this.#process;
  }

  async executeCommand(sessionId: string, command: string, abort?: () => void): Promise<ExecutionResult> {
    if (!this.process || !this.terminal) {
      return undefined;
    }

    const state = this.executionState.get();

    if (state?.active && state.abort) {
      state.abort();
    }

    /*
     * interrupt the current execution
     *  this.#shellInputStream?.write('\x03');
     */
    this.terminal.input('\x03');
    await this.waitTillOscCode('prompt');

    if (state && state.executionPrms) {
      await state.executionPrms;
    }

    //start a new execution
    this.terminal.input(command.trim() + '\n');

    //wait for the execution to finish
    const executionPromise = this.getCurrentExecutionResult();
    this.executionState.set({ sessionId, active: true, executionPrms: executionPromise, abort });

    const resp = await executionPromise;
    this.executionState.set({ sessionId, active: false });

    if (resp) {
      try {
        resp.output = cleanTerminalOutput(resp.output);
      } catch (error) {
        console.log('failed to format terminal output', error);
      }
    }

    return resp;
  }

  async getCurrentExecutionResult(): Promise<ExecutionResult> {
    /*
     * 🔴 On a shell with a begin marker (bash/PS0), the exit-wait must not trust exit markers that
     * predate OUR command — see `reduceOscSignals` for the measured npm-install kill this prevents.
     * jsh has no `beginOsc`, so this is `undefined` there and behaviour is unchanged.
     */
    const { output, exitCode } = await this.waitTillOscCode('exit', this.#sandbox?.shell.beginOsc);

    return { output, exitCode };
  }

  onQRCodeDetected?: (qrCode: string) => void;

  /**
   * Wait for an OSC code, sharing ONE stream reader with every other wait in flight.
   *
   * 🔴 **Two waits genuinely coexist**, and before the demultiplexer they raced: `executeCommand`
   * interrupts and waits for `prompt` while a parked start action is still waiting for `exit`. Each
   * had its own read loop over the SAME reader, and a `read()` hands a chunk to exactly one of them —
   * so when bash emits `exit`+`prompt` in a single chunk (the measured Ctrl-C shape), whichever loop
   * received it consumed BOTH signals and the other starved forever. The live creations only worked
   * because stale attach-draw markers happened to backfill the loser — a balance that depends on
   * where the PTY chose to split its writes.
   *
   * Now the pump reads once and routes every signal in a chunk to every registered waiter.
   */
  async waitTillOscCode(waitCode: string, afterOsc?: string): Promise<{ output: string; exitCode: number }> {
    if (!this.#outputStream) {
      return { output: '', exitCode: 0 };
    }

    /*
     * A wait registered AFTER the shell died would park forever with nothing left to wake it — the
     * pump has stopped and no further signal is coming. Failing up front also makes the second
     * action after a death loud instead of silent, which matters because the runner keeps going.
     */
    if (this.#processExit) {
      throw shellDiedError(this.#processExit.code, '');
    }

    return new Promise<{ output: string; exitCode: number }>((resolve, reject) => {
      this.#waiters.add({
        waitCode,
        afterOsc,

        /*
         * `afterOsc` (the shell's begin marker) arms the wait: signals seen before it are a PREVIOUS
         * command's leftovers and must not satisfy this one. Without a marker the state starts armed —
         * the jsh behaviour, unchanged. Accounting is `reduceOscSignals`, pure and pinned.
         */
        state: { armed: afterOsc === undefined, exitCode: 0, done: false },
        output: '',
        resolve,
        reject,
      });

      void this.#pumpOutput();
    });
  }

  /**
   * The single reader over the command stream: runs while anything is waiting, stops when nothing is.
   *
   * It stops rather than draining continuously on purpose. With no waiter registered there is nobody
   * to hand a signal to, and DROPPING one would be worse than leaving it in the stream — a marker
   * arriving in the gap between "the prompt wait resolved" and "the exit wait registered" is exactly
   * the completion `executeCommand` is about to wait for. Leaving it buffered preserves the
   * pre-demultiplexer behaviour, which `beginOsc` arming already makes safe against staleness.
   */
  async #pumpOutput(): Promise<void> {
    if (this.#pumping || !this.#outputStream) {
      return;
    }

    this.#pumping = true;

    const reader = this.#outputStream;

    try {
      while (this.#waiters.size > 0) {
        const { value, done } = await reader.read();

        if (done) {
          // The shell is gone: every wait resolves with what it has rather than hanging forever.
          for (const waiter of [...this.#waiters]) {
            this.#finishWaiter(waiter);
          }

          return;
        }

        this.#dispatchChunk(value || '');
      }
    } catch (error) {
      /*
       * 🔴 A stream ERROR must reach the waits, or the demultiplexer turns a loud failure into a
       * silent one. Before the pump, `read()` was awaited inside the caller's own promise, so a
       * rejection rejected the caller; with one shared loop the rejection has nowhere to go — it
       * escapes as an unhandled rejection while every wait parks forever. Rejecting keeps the
       * pre-change contract: fail loud, at the call site that was waiting.
       */
      for (const waiter of [...this.#waiters]) {
        this.#waiters.delete(waiter);
        waiter.reject(error instanceof Error ? error : new Error(String(error)));
      }
    } finally {
      this.#pumping = false;
    }
  }

  /** Route one chunk's text and OSC signals to every waiter still pending. */
  #dispatchChunk(text: string) {
    this.#captureExpoUrl(text);

    /*
     * EVERY signal in the chunk, in order — not just the first. A single `PROMPT_COMMAND` emits
     * `exit=0:<n>` and `prompt` back to back, so they land together and reading only the first made
     * the wait for `prompt` unsatisfiable. See `scanOscSignals` for the measured bytes.
     *
     * The carry lives on the PUMP, so an OSC sequence split across a chunk boundary survives even
     * when that boundary falls between two waits — a per-wait carry dropped it silently.
     */
    const { signals, rest } = scanOscSignals(this.#oscCarry + text);
    this.#oscCarry = rest;

    for (const waiter of [...this.#waiters]) {
      waiter.output += text;

      const wasArmed = waiter.state.armed;
      waiter.state = reduceOscSignals(waiter.state, signals, waiter.waitCode, waiter.afterOsc);

      /*
       * The output before the begin marker is the previous command's tail (its `^C`, its prompt) —
       * reporting it as OURS is how the start action's error came to read "npm install ^C". Coarse
       * (chunk-granular) on purpose: this feeds error messages, not parsing.
       */
      if (!wasArmed && waiter.state.armed) {
        waiter.output = text;
      }

      if (waiter.state.done) {
        this.#finishWaiter(waiter);
      }
    }
  }

  #finishWaiter(waiter: OscWaiter) {
    this.#waiters.delete(waiter);
    waiter.resolve({ output: waiter.output, exitCode: waiter.state.exitCode });
  }

  /**
   * The shell process exited: fail every wait, and remember so later waits fail immediately.
   *
   * REJECT rather than resolve, and this is the whole point. Resolving with `exitCode: 0` would tell
   * `#runStartAction` the dev server started fine (its check is `resp?.exitCode != 0`), turning a
   * hang into a false success — strictly worse, because the artifact would go green over a project
   * with no server. Resolving with a non-zero code would work today but relies on every caller
   * reading the code; a rejection cannot be ignored by a caller that forgets to look.
   *
   * The error names the shell rather than the command, because at this level that is all that is
   * known — the process that would have reported an exit code is the one that died.
   */
  #onProcessExit(code: number) {
    if (this.#processExit) {
      return;
    }

    this.#processExit = { code };

    for (const waiter of [...this.#waiters]) {
      this.#waiters.delete(waiter);
      waiter.reject(shellDiedError(code, waiter.output));
    }
  }

  /** Expo URL detection, once per chunk on the pump — it used to be per-wait, i.e. missed or doubled. */
  #captureExpoUrl(text: string) {
    this.#expoBuffer += text;

    const expoUrlMatch = this.#expoBuffer.match(/(exp:\/\/[^\s]+)/);

    if (!expoUrlMatch) {
      // Bounded: this buffer exists only so a URL split across chunks still matches.
      if (this.#expoBuffer.length > 2048) {
        this.#expoBuffer = this.#expoBuffer.slice(-2048);
      }

      return;
    }

    // Remove any trailing ANSI escape codes or non-printable characters
    const cleanUrl = expoUrlMatch[1]
      .replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '')
      .replace(/[^\x20-\x7E]+$/g, '');
    expoUrlAtom.set(cleanUrl);

    // Remove everything up to and including the URL from the buffer to avoid duplicate matches
    this.#expoBuffer = this.#expoBuffer.slice(this.#expoBuffer.indexOf(expoUrlMatch[1]) + expoUrlMatch[1].length);
  }
}

/**
 * Cleans and formats terminal output while preserving structure and paths
 * Handles ANSI, OSC, and various terminal control sequences
 */
export function cleanTerminalOutput(input: string): string {
  // Step 1: Remove OSC sequences (including those with parameters)
  const removeOsc = input
    .replace(/\x1b\](\d+;[^\x07\x1b]*|\d+[^\x07\x1b]*)\x07/g, '')
    .replace(/\](\d+;[^\n]*|\d+[^\n]*)/g, '');

  // Step 2: Remove ANSI escape sequences and color codes more thoroughly
  const removeAnsi = removeOsc
    // Remove all escape sequences with parameters
    .replace(/\u001b\[[\?]?[0-9;]*[a-zA-Z]/g, '')
    .replace(/\x1b\[[\?]?[0-9;]*[a-zA-Z]/g, '')
    // Remove color codes
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/\x1b\[[0-9;]*m/g, '')
    // Clean up any remaining escape characters
    .replace(/\u001b/g, '')
    .replace(/\x1b/g, '');

  // Step 3: Clean up carriage returns and newlines
  const cleanNewlines = removeAnsi
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n{3,}/g, '\n\n');

  // Step 4: Add newlines at key breakpoints while preserving paths
  const formatOutput = cleanNewlines
    // Preserve prompt line
    .replace(/^([~\/][^\n❯]+)❯/m, '$1\n❯')
    // Add newline before command output indicators
    .replace(/(?<!^|\n)>/g, '\n>')
    // Add newline before error keywords without breaking paths
    .replace(/(?<!^|\n|\w)(error|failed|warning|Error|Failed|Warning):/g, '\n$1:')
    // Add newline before 'at' in stack traces without breaking paths
    .replace(/(?<!^|\n|\/)(at\s+(?!async|sync))/g, '\nat ')
    // Ensure 'at async' stays on same line
    .replace(/\bat\s+async/g, 'at async')
    // Add newline before npm error indicators
    .replace(/(?<!^|\n)(npm ERR!)/g, '\n$1');

  // Step 5: Clean up whitespace while preserving intentional spacing
  const cleanSpaces = formatOutput
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join('\n');

  // Step 6: Final cleanup
  return cleanSpaces
    .replace(/\n{3,}/g, '\n\n') // Replace multiple newlines with double newlines
    .replace(/:\s+/g, ': ') // Normalize spacing after colons
    .replace(/\s{2,}/g, ' ') // Remove multiple spaces
    .replace(/^\s+|\s+$/g, '') // Trim start and end
    .replace(/\u0000/g, ''); // Remove null characters
}

export function newBoltShellProcess() {
  return new BoltShell();
}
