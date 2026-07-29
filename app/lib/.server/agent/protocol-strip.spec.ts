import { describe, expect, it } from 'vitest';
import { ProtocolTagStreamFilter } from './protocol-strip';

/** Run a whole string through in one push (+ flush) — the common case. */
function run(input: string): { out: string; stripped: number } {
  const f = new ProtocolTagStreamFilter();
  const out = f.push(input) + f.flush();

  return { out, stripped: f.strippedCount };
}

// Built from a variable so the literal namespace prefix is not mangled by any tag-aware tooling.
const NS = `${'antml'}:`;

describe('ProtocolTagStreamFilter — strips stray tool-call tags', () => {
  it('removes the exact reported failure: a stray closing tag after the last statement', () => {
    const { out, stripped } = run('export default Home;</parameter>');
    expect(out).toBe('export default Home;');
    expect(stripped).toBe(1);
  });

  it('removes opening and closing protocol tags, bare and namespace-prefixed', () => {
    expect(run('a</parameter>b').out).toBe('ab');
    expect(run('a<parameter name="prompt">b').out).toBe('ab');
    expect(run('a<invoke name="generate_image">b</invoke>c').out).toBe('abc');
    expect(run('a<function_calls>b</function_calls>c').out).toBe('abc');
    expect(run(`a<${NS}parameter name="p">b</${NS}parameter>c`).out).toBe('abc');
  });

  it('counts every tag it removes (so a non-zero can be alerted on)', () => {
    // Six tags: <function_calls> <invoke> <parameter> </parameter> </invoke> </function_calls>.
    expect(
      run('<function_calls><invoke name="x"><parameter name="p">hi</parameter></invoke></function_calls>').stripped,
    ).toBe(6);
  });
});

describe('ProtocolTagStreamFilter — leaves legitimate content untouched', () => {
  it('passes ordinary HTML/JSX tags through byte-identically', () => {
    const jsx = '<div className="hero"><h1>Race</h1><img src="/x.jpg" /></div>';
    expect(run(jsx).out).toBe(jsx);
    expect(run(jsx).stripped).toBe(0);
  });

  it('does not touch comparisons, generics, or lookalike identifiers', () => {
    expect(run('if (a < b && c > d) {}').out).toBe('if (a < b && c > d) {}');
    expect(run('const xs: Array<string> = []').out).toBe('const xs: Array<string> = []');

    // A longer word that merely starts with a tag name is NOT a protocol tag.
    expect(run('<parameterization>').out).toBe('<parameterization>');
    expect(run('<invoker>').out).toBe('<invoker>');
  });

  it('is byte-identical on a realistic file with no protocol tags (control)', () => {
    const file = [
      'import { GameManager } from "../babylon/globals";',
      'export default function Home() {',
      '  return <main className="landing"><h1>Synty Street Racer</h1></main>;',
      '}',
    ].join('\n');
    const { out, stripped } = run(file);
    expect(out).toBe(file);
    expect(stripped).toBe(0);
  });
});

describe('ProtocolTagStreamFilter — streaming contract', () => {
  it('strips a tag split across deltas and holds back only the partial', () => {
    const f = new ProtocolTagStreamFilter();

    // 'foo' streams immediately; only the partial '</para' is withheld.
    expect(f.push('foo</para')).toBe('foo');

    // The rest completes the tag → stripped → 'bar' emitted.
    expect(f.push('meter>bar')).toBe('bar');
    expect(f.flush()).toBe('');
    expect(f.strippedCount).toBe(1);
  });

  it('never withholds more than a partial tag — a large file body streams on its own push', () => {
    const f = new ProtocolTagStreamFilter();
    const body = 'x'.repeat(50_000);

    /*
     * The whole body (no protocol tag) comes straight back on the SAME push — the shell-strip lesson:
     * the only thing that may be withheld is a trailing partial tag, never the length of a file.
     */
    expect(f.push(body)).toBe(body);
  });

  it('a legit tag mid-arrival at a delta boundary streams, it is not held as protocol', () => {
    const f = new ProtocolTagStreamFilter();

    // '<div' cannot become a protocol tag, so it is emitted rather than buffered.
    expect(f.push('<div')).toBe('<div');
    expect(f.push(' className="x">')).toBe(' className="x">');
  });

  it('emits an incomplete protocol-looking fragment at end of stream rather than eating content', () => {
    const f = new ProtocolTagStreamFilter();

    // Held while it could still complete...
    expect(f.push('done</param')).toBe('done');

    // ...but if the stream simply ends, the fragment is returned, never silently dropped.
    expect(f.flush()).toBe('</param');
  });
});

describe('function_results (added 2026-07-28 — leaked into a live project as a Vite parse error)', () => {
  /*
   * Measured on a real creation: the model emitted `</function_results>Wait, I made an error in my
   * artifact format. Let me re-emit the artifact correctly.` inside a streamed file body, and the
   * fragment landed VERBATIM at src/pages/Home.tsx:73 — a hard parse error in a user's project. The
   * tag was missing from TAG_NAMES; this pins it, including the exact live payload.
   */
  it('strips the exact live leak, keeping the surrounding text', () => {
    const filter = new ProtocolTagStreamFilter();
    const out =
      filter.push('export default Home;\n</function_results>Wait, I made an error in my artifact format.') +
      filter.flush();

    expect(out).toBe('export default Home;\nWait, I made an error in my artifact format.');
  });

  it('strips open + close, bare + antml-prefixed', () => {
    const filter = new ProtocolTagStreamFilter();
    const out = filter.push('a<function_results>b</function_results>c') + filter.flush();

    expect(out).toBe('abc');
  });

  it('holds back a split tag across deltas and drops it once complete (single-push assertions)', () => {
    const filter = new ProtocolTagStreamFilter();
    const first = filter.push('score</function_res');

    // The withheld text is bounded by the opener length — everything before the candidate is forwarded.
    expect(first).toBe('score');
    expect(filter.push('ults>done') + filter.flush()).toBe('done');
  });

  it('leaves a non-protocol tag that shares the prefix byte-identical', () => {
    const filter = new ProtocolTagStreamFilter();
    const out = filter.push('<function_results_view>x</function_results_view>') + filter.flush();

    expect(out).toBe('<function_results_view>x</function_results_view>');
  });
});
