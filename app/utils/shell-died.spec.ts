/**
 * A dead shell must fail its waits, not park them (`spec/fail-loud.md`).
 *
 * ## The defect, measured
 *
 * `#pumpOutput` already handled the command stream ENDING (`done`) and ERRORING. It did not handle
 * the third case: the shell PROCESS exiting while its PTY stays open. `read()` then never returns,
 * every registered wait parks forever, and `executeCommand` never settles — so the action runner's
 * `.then` and `.catch` around `#runStartAction`, both correct, are attached to a promise that never
 * resolves.
 *
 * Live on a cloned Vite 8 project (2026-08-03): `npm run dev` printed `> vite`, the dev server died,
 * and the `start` row sat at `running` — which draws a terminal-window icon, the only icon that
 * status has — with no error, no alert, and a blank Preview tab. Running the identical command by
 * hand in a fresh shell brought Vite up in 787ms, so nothing was wrong with the project.
 *
 * Not a wrong answer: **no answer**. Same shape as the execution-queue poisoning, one layer down.
 *
 * ## What is asserted
 *
 * The error's wording (the only thing a user is told), and that it REJECTS rather than resolving —
 * `#runStartAction` reads `resp?.exitCode != 0`, so resolving `{exitCode: 0}` on a dead shell would
 * report the dev server as started. A hang is bad; a false green is worse.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { shellDiedError } from './shell';

describe('shellDiedError — the sentence the user actually gets', () => {
  it('names the exit code when the shell reported one', () => {
    const error = shellDiedError(1, '');

    expect(error.message).toContain('exited (code 1)');
    expect(error.name).toBe('ShellDiedError');
  });

  it('distinguishes "we could not learn the code" from "exited 0"', () => {
    /*
     * `-1` is the provider's `exit` promise rejecting. Printing that as an exit code would state a
     * fact we do not have — the `mount-source.ts` `undefined`-vs-`null` distinction, one door over.
     */
    const unknown = shellDiedError(-1, '');

    expect(unknown.message).toContain('stopped unexpectedly');
    expect(unknown.message).not.toMatch(/code -1|code 0/);

    expect(shellDiedError(0, '').message).toContain('exited (code 0)');
  });

  it('carries what the command printed before dying — that is the crash', () => {
    const error = shellDiedError(1, '> vite\nError: Cannot find native binding\n');

    expect(error.message).toContain('Cannot find native binding');
  });

  it('does not append an empty block when there was no output', () => {
    // A dangling "\n\n" reads as truncated output rather than as no output.
    expect(shellDiedError(1, '   \n  ').message.trimEnd()).toBe(shellDiedError(1, '').message.trimEnd());
  });

  it('always says the running command was stopped, so the blank preview is explained', () => {
    for (const code of [-1, 0, 1, 137]) {
      expect(shellDiedError(code, '').message).toContain('was stopped');
    }
  });
});

/**
 * The wiring, read from source.
 *
 * `BoltShell` cannot be constructed in a unit test — it needs a sandbox, a PTY and an xterm — and a
 * behaviour no test can reach is exactly how the original hang survived. These assert the three
 * decisions that make the difference between loud and silent, each of which is a one-line revert.
 */
describe('the wiring that makes a dead shell loud', () => {
  const SHELL = readFileSync('app/utils/shell.ts', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const RUNNER = readFileSync('app/lib/runtime/action-runner.ts', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

  it('control: the sources are read and comment prose is stripped', () => {
    expect(SHELL).toContain('class BoltShell');
    expect(SHELL).not.toContain('A DEAD PROCESS IS NOT A CLOSED STREAM');
  });

  it('subscribes to the process exit at init', () => {
    expect(SHELL, 'nothing else observes the shell dying').toMatch(/process\.exit\s*\n?\s*\.then/);
    expect(SHELL, 'a rejecting exit promise must not become an unhandled rejection').toMatch(
      /\.catch\(\(\)\s*=>\s*this\.#onProcessExit\(-1\)\)/,
    );
  });

  it('REJECTS pending waits — resolving would report a dead server as started', () => {
    const handler = /#onProcessExit\(code: number\)\s*\{([\s\S]*?)\n  \}/.exec(SHELL)?.[1];

    expect(handler, '#onProcessExit must exist').toBeDefined();
    expect(handler).toContain('waiter.reject(shellDiedError(');
    expect(handler, 'resolving here is the false-green bug').not.toContain('waiter.resolve');
  });

  it('fails waits registered AFTER the death instead of parking them', () => {
    // The pump has stopped by then, so nothing would ever wake them.
    expect(SHELL).toMatch(/if \(this\.#processExit\) \{\s*throw shellDiedError/);
  });

  it('the runner re-throws as ActionCommandError, the only type that alerts', () => {
    /*
     * Its catch does `if (!(err instanceof ActionCommandError)) return;` before showing the alert —
     * so a plain Error marks the row failed and still tells the user nothing.
     */
    expect(RUNNER).toMatch(/catch \(error\)[\s\S]{0,400}new ActionCommandError\(\s*'Dev server stopped'/);
    expect(RUNNER, 'the alert path must still be gated on the type it was gated on').toContain(
      'err instanceof ActionCommandError',
    );
  });

  it('the failed row shows the real cause, not the constant "Action failed"', () => {
    expect(RUNNER).toMatch(/error: err instanceof ActionCommandError \? err\.header : 'Action failed'/);
  });
});
