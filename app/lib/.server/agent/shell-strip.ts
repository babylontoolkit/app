/**
 * Server-side shell-action strip (SPEC §4.2.5, §5 — "enforced client-side in the executor AND the
 * server strips disallowed actions from streams as defense-in-depth").
 *
 * The real enforcement point is the client executor: the shell only exists inside the user's own
 * WebContainer, and `action-runner.ts` refuses anything outside the `npm install` / `npm run`
 * allow-list before it runs. This is the OTHER half — a belt-and-suspenders filter on the model's
 * output stream, so a disallowed `<boltAction type="shell">` (or `type="start"`) never even reaches the
 * client, whatever a future client bug might do with it.
 *
 * It is a STREAMING filter because the proxy forwards the model's text incrementally: an action block
 * arrives across many deltas. The filter buffers only what it must — the text inside a not-yet-closed
 * action, and a possible partial `<boltAction` tag split across a delta boundary — and passes
 * everything else straight through, so the artifact still streams to the user in real time.
 *
 * File actions and prose are ALWAYS passed through verbatim: this strips ONLY disallowed shell/start
 * commands, reusing the exact same allow-list the client executor enforces so the two can never
 * disagree about what is permitted.
 */
import { isAllowedShellCommand } from '~/lib/runtime/shell-allowlist';

const OPEN = '<boltAction';
const CLOSE = '</boltAction>';

/** How much of a trailing partial `<boltAction` prefix to hold back, so a split tag is never missed. */
function partialPrefixLen(buffer: string): number {
  const max = Math.min(buffer.length, OPEN.length - 1);

  for (let k = max; k >= 1; k--) {
    if (buffer.endsWith(OPEN.slice(0, k))) {
      return k;
    }
  }

  return 0;
}

export interface StrippedCommand {
  command: string;
  reason: string;
}

export class ShellActionStreamFilter {
  private _buffer = '';

  /** Disallowed commands seen this generation — the caller logs/alerts on these. */
  readonly stripped: StrippedCommand[] = [];

  /** Feed one text delta; returns the text that is now safe to forward (may be empty). */
  push(delta: string): string {
    this._buffer += delta;

    let out = '';
    let i = 0;

    while (true) {
      const open = this._buffer.indexOf(OPEN, i);

      if (open === -1) {
        /*
         * No opening tag ahead. Emit everything except a possible partial `<boltAction` at the very
         * end — that suffix might complete into an action on the next delta, so hold it back.
         */
        const retain = partialPrefixLen(this._buffer);
        const safeEnd = this._buffer.length - retain;
        out += this._buffer.slice(i, Math.max(i, safeEnd));
        this._buffer = this._buffer.slice(Math.max(i, safeEnd));

        return out;
      }

      // Prose before the action streams immediately.
      out += this._buffer.slice(i, open);

      const tagEnd = this._buffer.indexOf('>', open);

      if (tagEnd === -1) {
        // The opening tag itself is incomplete — wait for the rest.
        this._buffer = this._buffer.slice(open);
        return out;
      }

      const openingTag = this._buffer.slice(open, tagEnd + 1);
      const type = openingTag.match(/type="([^"]*)"/)?.[1] ?? '';
      const close = this._buffer.indexOf(CLOSE, tagEnd + 1);

      if (close === -1) {
        // Body not closed yet — buffer the whole action until we can judge it.
        this._buffer = this._buffer.slice(open);
        return out;
      }

      const blockEnd = close + CLOSE.length;
      const block = this._buffer.slice(open, blockEnd);

      if (type === 'shell' || type === 'start') {
        const command = this._buffer.slice(tagEnd + 1, close).trim();
        const verdict = isAllowedShellCommand(command);

        if (verdict.allowed) {
          out += block;
        } else {
          /*
           * Disallowed — DROP the entire action from the client-facing stream. The client executor
           * would refuse it anyway; here it never arrives. Recorded so the caller can surface that the
           * model tried something outside the allow-list.
           */
          this.stripped.push({ command, reason: verdict.reason ?? 'not permitted' });
        }
      } else {
        // File actions and anything else pass through untouched.
        out += block;
      }

      i = blockEnd;
    }
  }

  /** End of stream — emit whatever remains (an unclosed action cannot be executed by the client). */
  flush(): string {
    const rest = this._buffer;
    this._buffer = '';

    return rest;
  }
}
