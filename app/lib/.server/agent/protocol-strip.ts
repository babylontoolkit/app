/**
 * Server-side stray tool-call-tag strip (SPEC §4.2, §5 — defense-in-depth on the model's output stream).
 *
 * ## The failure this exists for
 *
 * The model invokes tools (`generate_image`, MCP tools, …) using a tool-call protocol. Every now and
 * then a fragment of that protocol — most often a stray closing `</parameter>` — leaks into the TEXT
 * channel instead of staying in the tool-call channel. The text channel feeds the artifact parser, which
 * writes files, so the stray tag lands verbatim in the user's source:
 *
 *     export default Home;</parameter>          ← a syntax error in Home.tsx
 *
 * It surfaced as "every now and then the landing-page redesign ships a broken build", because a landing
 * redesign also generates media (§4.16), so it is a turn dense with tool calls — the exact condition
 * that makes a leak likely. A wording change in a skill cannot fix this: a model does not reliably
 * refrain from ever emitting a stray protocol tag. The pipeline has to refuse to WRITE it, the same way
 * `shell-strip.ts` refuses to forward a disallowed shell command.
 *
 * ## Why stripping these tags is safe
 *
 * `<parameter>` / `<invoke>` / `<function_calls>` (and their `antml:`-prefixed variants) are tool-call
 * protocol. They are NEVER legitimate content in a Babylon/TypeScript/CSS web game — unlike, say, `<div>`
 * or `a < b`, which this filter leaves untouched. So removing them from the stream can only remove a
 * defect. The one honest cost: if the model's PROSE explanation literally quotes one of these tags (as
 * an assistant does when apologising for this very bug), the quote loses the tag — a cosmetic loss in a
 * sentence, weighed against a syntax error in a file the user has to ship.
 *
 * ## Streaming contract (the same one `shell-strip` learned the hard way)
 *
 * This is a STREAMING filter: text arrives in deltas and must be forwarded as it arrives, or the preview
 * looks frozen. The ONLY text it may withhold is a trailing partial that could still become a protocol
 * tag — bounded by the length of the longest tag opener (~16 chars), NEVER by the length of a file.
 * Everything else, including every non-protocol `<tag>` and all prose, passes through on the same push.
 */

/**
 * A COMPLETE protocol tag at the start of the slice: `<parameter …>`, `</invoke>`, `<function_calls>`,
 * etc., with or without an `antml:` prefix and with or without attributes.
 *
 * The `(?:\s[^>]*)?>` tail means the tag name must be followed by whitespace-then-attributes or an
 * immediate `>`, so `<parameterization>` (name is a longer word) is NOT matched — we strip the protocol
 * tags and nothing that merely starts with their letters.
 */
const PROTOCOL_TAG = /^<\/?(?:antml:)?(?:function_calls|function_results|invoke|parameter)(?:\s[^>]*)?>/;

/**
 * Tag-name OPENERS (no attributes), both bare and namespace-prefixed. A trailing buffer fragment is held
 * back only if it is still a candidate to become one of these — either a prefix of an opener (`<param`)
 * or an opener already matched with attributes accruing (`<parameter name="pro`). This is what bounds the
 * withheld text by the length of the longest opener, never the length of a file.
 *
 * Built from base names (the prefix assembled from a variable) so the same list covers both the bare
 * form the platform models emit and the namespace-prefixed form other providers use — and stays in step
 * with `PROTOCOL_TAG`'s optional-prefix group.
 */
/*
 * `function_results` joined 2026-07-28 (T17c live drive): the model leaked `</function_results>` plus
 * its own "Let me re-emit the artifact correctly" recovery prose into a streamed artifact, and the
 * fragment was written VERBATIM into the game's `Home.tsx` — a hard Vite parse error on line 73 of a
 * user's project. Same defect class the module exists for; the tag was simply missing from the list.
 */
const TAG_NAMES = ['function_calls', 'function_results', 'invoke', 'parameter'];
const TAG_PREFIX = `${'antml'}:`;
const OPENERS = TAG_NAMES.flatMap((name) => [
  `<${name}`,
  `</${name}`,
  `<${TAG_PREFIX}${name}`,
  `</${TAG_PREFIX}${name}`,
]);

/** Could `fragment` (starts with `<`, contains no `>`) still complete into a protocol tag? */
function couldStartProtocolTag(fragment: string): boolean {
  return OPENERS.some((opener) => opener.startsWith(fragment) || fragment.startsWith(opener));
}

export class ProtocolTagStreamFilter {
  private _buffer = '';

  /** How many stray protocol tags were removed this generation — the caller logs/alerts on a non-zero. */
  private _strippedCount = 0;

  get strippedCount(): number {
    return this._strippedCount;
  }

  /** Feed one text delta; returns the text that is now safe to forward (may be empty). */
  push(delta: string): string {
    this._buffer += delta;

    const buf = this._buffer;
    let out = '';
    let i = 0;

    while (i < buf.length) {
      const lt = buf.indexOf('<', i);

      if (lt === -1) {
        // No more tags possible — the rest is plain text.
        out += buf.slice(i);
        i = buf.length;
        break;
      }

      // Everything before the '<' is plain text and streams immediately.
      out += buf.slice(i, lt);
      i = lt;

      const rest = buf.slice(lt);
      const complete = rest.match(PROTOCOL_TAG);

      if (complete) {
        // A whole stray protocol tag — drop it and keep scanning.
        this._strippedCount++;
        i = lt + complete[0].length;
        continue;
      }

      if (rest.indexOf('>') === -1) {
        /*
         * An unclosed tag at the end of the buffer. Hold it back ONLY if it could still be a protocol
         * tag; otherwise it is an ordinary tag mid-arrival (`<div`, `<img`) and streams now.
         */
        if (couldStartProtocolTag(rest)) {
          break;
        }

        out += '<';
        i = lt + 1;
        continue;
      }

      /*
       * A complete tag that is NOT protocol (`<div>`, `<Foo bar>`): emit the '<' and let its body stream
       * as ordinary text on the next iterations.
       */
      out += '<';
      i = lt + 1;
    }

    this._buffer = buf.slice(i);

    return out;
  }

  /** End of stream — emit whatever remains (a partial tag that never completed is just text now). */
  flush(): string {
    const rest = this._buffer;
    this._buffer = '';

    return rest;
  }
}
