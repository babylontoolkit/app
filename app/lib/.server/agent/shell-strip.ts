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
 * arrives across many deltas. File actions and prose are passed through verbatim AS THEY ARRIVE; this
 * strips ONLY disallowed shell/start commands, reusing the exact same allow-list the client executor
 * enforces so the two can never disagree about what is permitted.
 *
 * ## What may be withheld, and why it is only ever a few bytes
 *
 * A verdict needs the WHOLE command: `npm install x` and `npm install x && rm -rf /` share a prefix,
 * so a `shell` action is buffered until its close tag. That is safe to do because commands are ~20
 * bytes and arrive in one delta.
 *
 * Applying that same rule to a FILE action is the trap, and this filter fell into it: `type="file"`
 * carries no verdict — the answer is "pass it through" the moment the opening tag is read — but the
 * code checked for the close tag BEFORE looking at the type it had just parsed, so every file was held
 * until complete. Measured on a real generation: a 13,776-char game script reached the browser 51
 * SECONDS after the model began sending it, in one lump. Nothing threw and the artifact was byte-
 * perfect; the product simply looked frozen, and the freeze scaled with the size of the file.
 *
 * So the invariant is: the ONLY text withheld is text whose safety is not yet decidable — a shell
 * command mid-read, or a partial tag split across a delta boundary. Both are bounded by the length of
 * a TAG. Neither is bounded by the length of a file.
 *
 * ⚠️ A test that concatenates every `push` plus `flush` before asserting CANNOT see this class of bug —
 * a filter that withholds everything until the last byte passes it. `shell-strip.spec.ts` asserts on
 * the return of a single `push` for exactly that reason; keep it that way.
 */
import { isAllowedShellCommand } from '~/lib/runtime/shell-allowlist';

const OPEN = '<boltAction';
const CLOSE = '</boltAction>';

/**
 * How much of a trailing partial `tag` to hold back, so a tag split across deltas is never missed.
 *
 * This is the ONLY text a pass-through action may withhold, which is what bounds the delay by the
 * length of a tag (13 chars) instead of the length of a file (13,000).
 */
function partialTagLen(buffer: string, tag: string): number {
  const max = Math.min(buffer.length, tag.length - 1);

  for (let k = max; k >= 1; k--) {
    if (buffer.endsWith(tag.slice(0, k))) {
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

  /**
   * Inside a non-shell action whose body is streaming straight through.
   *
   * The state matters because the decision has ALREADY been made — a `type="file"` action has no
   * verdict pending — so the only thing left to watch for is its close tag.
   */
  private _passingThrough = false;

  /** Disallowed commands seen this generation — the caller logs/alerts on these. */
  readonly stripped: StrippedCommand[] = [];

  /** Feed one text delta; returns the text that is now safe to forward (may be empty). */
  push(delta: string): string {
    this._buffer += delta;

    let out = '';

    while (true) {
      /*
       * Streaming a file body: emit on arrival, holding back only a possible partial close tag. This
       * is the difference between a file appearing in the editor as it is written and a 51-second
       * freeze followed by 13,776 characters at once.
       */
      if (this._passingThrough) {
        const close = this._buffer.indexOf(CLOSE);

        if (close === -1) {
          const retain = partialTagLen(this._buffer, CLOSE);
          const safeEnd = this._buffer.length - retain;
          out += this._buffer.slice(0, safeEnd);
          this._buffer = this._buffer.slice(safeEnd);

          return out;
        }

        const end = close + CLOSE.length;
        out += this._buffer.slice(0, end);
        this._buffer = this._buffer.slice(end);
        this._passingThrough = false;

        continue;
      }

      const open = this._buffer.indexOf(OPEN);

      if (open === -1) {
        /*
         * No opening tag ahead. Emit everything except a possible partial `<boltAction` at the very
         * end — that suffix might complete into an action on the next delta, so hold it back.
         */
        const retain = partialTagLen(this._buffer, OPEN);
        const safeEnd = this._buffer.length - retain;
        out += this._buffer.slice(0, safeEnd);
        this._buffer = this._buffer.slice(safeEnd);

        return out;
      }

      // Prose before the action streams immediately.
      out += this._buffer.slice(0, open);
      this._buffer = this._buffer.slice(open);

      const tagEnd = this._buffer.indexOf('>');

      if (tagEnd === -1) {
        // The opening tag itself is incomplete — wait for the rest.
        return out;
      }

      const openingTag = this._buffer.slice(0, tagEnd + 1);
      const type = openingTag.match(/type="([^"]*)"/)?.[1] ?? '';

      /*
       * Not a shell action, so there is nothing to judge and nothing to wait for: forward the tag and
       * stream the body. Only `shell`/`start` carry a command that must be read in full before it can
       * be allowed or dropped — and those are ~20 bytes, so buffering them costs nobody anything.
       */
      if (type !== 'shell' && type !== 'start') {
        out += openingTag;
        this._buffer = this._buffer.slice(tagEnd + 1);
        this._passingThrough = true;

        continue;
      }

      const close = this._buffer.indexOf(CLOSE, tagEnd + 1);

      if (close === -1) {
        /*
         * A half-read command cannot be judged: `npm install x` and `npm install x && rm -rf /` share
         * a prefix, so the verdict has to wait for the close tag.
         */
        return out;
      }

      const blockEnd = close + CLOSE.length;
      const block = this._buffer.slice(0, blockEnd);
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

      this._buffer = this._buffer.slice(blockEnd);
    }
  }

  /** End of stream — emit whatever remains (an unclosed action cannot be executed by the client). */
  flush(): string {
    const rest = this._buffer;
    this._buffer = '';
    this._passingThrough = false;

    return rest;
  }
}
