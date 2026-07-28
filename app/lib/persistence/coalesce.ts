/**
 * "Do this once the noise stops" — a trailing debounce that also DEFERS while the app is busy
 * (SPEC §4.5.5, §4.16).
 *
 * ## The failure this exists for (measured live 2026-07-27, CodeSandbox)
 *
 * `takeSnapshot` calls `workbenchStore.serializeFiles()` — read every binary in the project, base64 it,
 * write the lot to IndexedDB. It is called from `storeMessageHistory`, which the 50ms sampler runs on
 * every mutation of the message array. While a generation streams, that is several times a SECOND.
 *
 * On WebContainer a binary read is a memory copy, so this was merely wasteful and nobody noticed. On a
 * server sandbox every read is a round trip, and the measured result was a pile-up:
 *
 *     ERROR FilesStore  Failed to read binary file for serialization:
 *       /project/workspace/public/scripts/havok.wasm
 *       Error: null: Pitcher message fs/readFile timed out
 *
 * — hundreds of them, for `havok.wasm`, `glslang.wasm`, `twgsl.wasm` and every starter image, because
 * eight full-project serializations were in flight at once fighting over one message channel. Each new
 * tick started another before the last had finished. The heap climbed past 870MB and the tab crawled.
 *
 * `checkpointProject`'s doc comment had already named this exact trap ("upstream fires that on every
 * mutation of the message array… 160+ checkpoints for ONE message") — but only the SERVER UPLOAD was
 * moved off that path. The local serialization, which is the expensive half, stayed where it was.
 *
 * ## Why coalescing is SAFE here specifically
 *
 * The snapshot is keyed by chat id and OVERWRITTEN on every write, so only the last one in a burst has
 * any effect. Two hundred writes and one write leave byte-identical state; the other 199 are pure cost.
 * That is what makes this a debounce rather than a queue — do not reuse it for anything APPEND-only,
 * where a dropped call is a lost record rather than a skipped duplicate.
 *
 * ## Why `isBusy` is separate from the delay
 *
 * A timer alone cannot express "not while the stream is running". A long generation would fire the
 * trailing edge mid-stream and put the storm right back, so a busy tick RE-ARMS instead of running —
 * the work lands once, after the last thing that could invalidate it.
 *
 * Timers are injected so this is testable without real time, for the same reason `settle.ts` injects
 * its clock: a test that waits on `setTimeout` is a test that is slow and flaky about the one property
 * it exists to pin.
 */

/* Wrappers, not the globals themselves: the injected shape is `unknown`-handled and `clearTimeout` is not. */
const defaultSetTimer = (fn: () => void, ms: number): unknown => setTimeout(fn, ms);
const defaultClearTimer = (handle: unknown): void => clearTimeout(handle as ReturnType<typeof setTimeout>);

export interface CoalesceOptions {
  /** Trailing window. A burst shorter than this collapses into one run. */
  delayMs: number;

  /** While true, the run is deferred and the timer re-armed. */
  isBusy: () => boolean;

  /** The expensive work. Never called concurrently with itself — see `#running`. */
  run: () => Promise<void>;

  /** Injected for tests. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;

  /** Reported, never thrown — a coalesced best-effort task must not break its caller. */
  onError?: (error: unknown) => void;
}

export class CoalescedTask {
  #options: CoalesceOptions;
  #timer: unknown;

  /**
   * 🔴 The re-entrancy guard, and the whole point of the class.
   *
   * `run` is async and slower than the window that schedules it — that is the defect this fixes. A
   * plain debounce still allows run N+1 to start while run N is awaiting, which on a serialization
   * task means two full-project reads competing. So a request that arrives mid-run sets a flag and is
   * re-armed on completion instead of starting a second pass.
   */
  #running = false;
  #requestedWhileRunning = false;

  constructor(options: CoalesceOptions) {
    this.#options = options;
  }

  /** Ask for a run. Cheap, synchronous, safe to call from a hot path. */
  request(): void {
    const { setTimer = defaultSetTimer, clearTimer = defaultClearTimer, delayMs } = this.#options;

    if (this.#running) {
      this.#requestedWhileRunning = true;
      return;
    }

    if (this.#timer !== undefined) {
      clearTimer(this.#timer);
    }

    this.#timer = setTimer(() => {
      this.#timer = undefined;
      void this.#fire();
    }, delayMs);
  }

  /** Drop a pending run — for teardown, so a unmounted chat cannot write over a newly mounted one. */
  cancel(): void {
    const { clearTimer = defaultClearTimer } = this.#options;

    if (this.#timer !== undefined) {
      clearTimer(this.#timer);
      this.#timer = undefined;
    }

    this.#requestedWhileRunning = false;
  }

  async #fire(): Promise<void> {
    // Busy: re-arm rather than run. The trailing edge must land AFTER the thing that keeps changing.
    if (this.#options.isBusy()) {
      this.request();
      return;
    }

    this.#running = true;

    try {
      await this.#options.run();
    } catch (error) {
      this.#options.onError?.(error);
    } finally {
      this.#running = false;
    }

    // Something asked while we were working — that request has not been served yet.
    if (this.#requestedWhileRunning) {
      this.#requestedWhileRunning = false;
      this.request();
    }
  }
}
