/**
 * THE FINGERPRINT IS COMPUTED AT THE SEAM, NOT AT A CALL SITE — AND SIX CALL SITES MUST REACH IT.
 *
 * `computeRequestFingerprint` is pure and exhaustively tested next door. What no unit test can see is
 * whether the proxy actually CALLS it, calls it once, and calls it from inside `startStream` rather
 * than at whichever call site somebody remembered. That distinction is the whole feature: the request
 * this record exists to expose is not the first one, it is the RE-ISSUE — the provider retry that
 * drops the tool definitions and splices in a synthetic system block, the forced continuation, the
 * rescue, the completeness pass. A fingerprint bolted to the first call site would record the one
 * request nobody was ever confused about.
 *
 * So this is a source scan, for `budgets-wiring.spec.ts`'s reason: `runAgentGeneration` cannot be
 * constructed in a unit test (it boots the prompt store, the ledger and a provider), and the
 * interesting failure is a seventh call site added without a label.
 *
 * ⚠️ The COMPILER owns half of this and it is the better half: `kind` is a REQUIRED positional
 * parameter, so a new call site that forgets one is `TS2554: Expected 3-5 arguments, but got 2`
 * rather than a fingerprint quietly labelled `undefined`. Mutation-verified against the real
 * compiler. This file owns the half the compiler cannot see — that the six labels are DISTINCT, and
 * that the call lives in the closure.
 *
 * ⚠️ CONTROLS below, because a scanner whose pattern silently stops matching reports a clean bill of
 * health forever.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeRequestFingerprint, type RequestKind } from './request-fingerprint';

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

/** The doc comments quote these identifiers constantly; a scan that counts prose proves nothing. */
const codeOnly = (source: string) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('//'))
    .join('\n');

const proxy = () => codeOnly(read('app/lib/.server/agent/proxy.ts'));

/** The body of the `startStream` closure, from its signature to the `_streamText` call it returns. */
const startStreamBody = () => proxy().match(/const startStream = \([\s\S]*?return _streamText\(\{/)?.[0] ?? '';

/** Every `startStream(` CALL — the declaration reads `startStream = (`, so it is not one of these. */
const callSites = () => [...proxy().matchAll(/startStream\(\s*(?:'([a-z-]+)')?/g)];

describe('the proxy fingerprints every request it starts', () => {
  it('computes the fingerprint exactly once, and inside the seam', () => {
    /*
     * 🔴 ONCE. Two calls means two answers to "what did we send", and the one that reaches the record
     * would be decided by ordering — the two-writers drift this repo keeps rediscovering.
     */
    expect(proxy().match(/computeRequestFingerprint\(/g)).toHaveLength(1);
    expect(startStreamBody(), 'startStream body not found').not.toBe('');
    expect(startStreamBody()).toMatch(/requests\.push\(\s*computeRequestFingerprint\(/);
  });

  /*
   * AFTER assembly and READ-ONLY. The fingerprint may never enter `system[]`, a tool schema or an
   * annotation the model can read back (§4.2.8): a verifier that perturbed one byte of the cached
   * prefix would cost more than every defect it watches for.
   */
  it('never lets the fingerprint reach the model', () => {
    const source = proxy();

    expect(source).not.toMatch(/system\.push\([\s\S]{0,200}fingerprint/i);
    expect(source).not.toMatch(/content:[^\n]*computeRequestFingerprint/);
    expect(source).not.toMatch(/messages:[^\n]*requests\b/);
  });

  it('records the request that is actually sent, not a second description of it', () => {
    const body = startStreamBody();

    /*
     * `toolChoice` and `maxSteps` are computed ONCE and handed to both the fingerprint and the SDK.
     * Recomputing them for the record is how a fingerprint ends up describing a request that was
     * never sent — true, self-consistent, and about nothing.
     */
    expect(body).toMatch(/const toolChoice = allowTools \? 'auto'/);
    expect(body).toMatch(/const maxSteps = allowTools \? toolPolicy\.maxSteps : 1/);
    expect(body).toMatch(/const maxTokens = 64_000;/);
    expect(body).toMatch(/toolNames: Object\.keys\(activeTools\)/);
    expect(body).toMatch(/messages: history/);

    /*
     * `effort` and the offered tool names are the two per-turn decisions that were unrecoverable from
     * the record before this feature (`steps[].tools` records tools CALLED, a different fact). Neither
     * is pinned by anything else, so dropping either from the fingerprint call would be silent.
     */
    expect(body).toMatch(/^\s*effort,$/m);
    expect(body).toMatch(/thinkingMode: modelOverride \|\| !supportsAdaptiveThinking\(model\)/);

    /*
     * 🔴 EVERY scalar the fingerprint records must be the SAME BINDING the SDK is handed — not a
     * second literal that happens to agree today. `maxTokens` was a duplicated `64_000` on both
     * sides: changing the wire value alone made the fingerprint lie about the request while all 39
     * tests stayed green, in the one module whose entire purpose is that the two agree. So this
     * asserts the ABSENCE of a second literal, which is the half that can actually catch it.
     */
    const source = proxy();

    expect(source.match(/64_000/g), 'the token cap must exist exactly once, as a binding').toHaveLength(1);
    expect(
      source,
      'maxTokens must be passed as the shared binding (`maxTokens,`), never re-specified with a value',
    ).not.toMatch(/maxTokens:\s*\S/);
  });

  it('has six call sites and every one of them is labelled', () => {
    const sites = callSites();

    expect(sites).toHaveLength(6);

    for (const site of sites) {
      expect(site[1], `an unlabelled startStream call: ${site[0]}`).toBeTruthy();
    }
  });

  /*
   * 🔴 DISTINCT. The two retry shapes differ in the TOOL SET and in the SYSTEM ARRAY — the tool-free
   * one drops the definitions outright and splices a synthetic recap block between `system` and the
   * conversation. Giving them one label would merge the two requests a mismatch report most needs to
   * tell apart, which is the collapse this record exists to prevent.
   */
  it('labels the six call sites distinctly', () => {
    const labels = callSites().map((m) => m[1]);

    expect(new Set(labels).size).toBe(labels.length);
    expect([...labels].sort()).toEqual([
      'creation-completeness',
      'first',
      'forced-continuation',
      'provider-retry',
      'provider-retry-tool-free',
      'unproductive-rescue',
    ]);
  });

  /* Every label the proxy passes must be a declared `RequestKind`, or the union is decorative. */
  it('passes only labels the type declares', () => {
    const declared: RequestKind[] = [
      'first',
      'provider-retry',
      'provider-retry-tool-free',
      'forced-continuation',
      'unproductive-rescue',
      'creation-completeness',
    ];

    for (const label of callSites().map((m) => m[1])) {
      expect(declared).toContain(label as RequestKind);
    }
  });

  /*
   * The array is APPEND-ONLY within a turn. A re-issue must add to it; anything that reassigns or
   * empties it turns a two-request turn back into a one-request record, silently.
   */
  it('accumulates into an ordered array it never clears', () => {
    const source = proxy();

    expect(source).toMatch(/const requests: RequestFingerprint\[\] = \[\];/);
    expect(source).not.toMatch(/requests = \[/);
    expect(source).not.toMatch(/requests\.(length = 0|splice|shift|pop)\b/);
  });
});

/**
 * The structural consequence, made explicit. `requests.push` is unconditional inside the closure and
 * the labels are distinct, so a turn that forces a continuation necessarily produces two entries with
 * different `kind`s — this asserts the half that is a value rather than a source pattern.
 */
describe('a re-issued turn produces two distinguishable fingerprints', () => {
  const fp = (kind: RequestKind, toolNames: string[]) =>
    computeRequestFingerprint({
      kind,
      messages: [
        { role: 'system', content: '# Base prompt' },
        { role: 'user', content: 'build me a kart racer' },
      ],
      toolNames,
      toolChoice: toolNames.length > 0 ? 'none' : 'omitted',
      maxSteps: 1,
      maxTokens: 64_000,
      model: 'claude-sonnet-5',
    });

  it('keeps the first request and the continuation apart', () => {
    const first = fp('first', ['read_file', 'load_skill']);
    const continuation = fp('forced-continuation', ['read_file', 'load_skill']);

    expect(first.kind).toBe('first');
    expect(continuation.kind).toBe('forced-continuation');
    expect(JSON.stringify(first)).not.toBe(JSON.stringify(continuation));
  });

  it('records the tool-free retry as a genuinely different request', () => {
    const retry = fp('provider-retry', ['read_file', 'generate_image']);
    const toolFree = fp('provider-retry-tool-free', []);

    expect(retry.toolNames).toEqual(['generate_image', 'read_file']);
    expect(toolFree.toolNames).toEqual([]);
    expect(toolFree.toolChoice, 'an empty tool set must not send toolChoice at all').toBe('omitted');
  });
});

/**
 * CONTROLS. Every assertion above is a regex over a 3,000-line file that is edited constantly.
 */
describe('CONTROLS — the scanner still reads the file it thinks it does', () => {
  it('finds the proxy, and it is a real module', () => {
    const source = proxy();

    expect(source.length).toBeGreaterThan(30_000);
    expect(source).toContain('runAgentGeneration');
    expect(source).toContain('_streamText');
  });

  it('strips comments rather than matching prose', () => {
    const stripped = codeOnly(
      ["/* startStream('first', …) */", 'const real = 1;', "// startStream('first'"].join('\n'),
    );

    expect(stripped).toContain('const real = 1;');
    expect(stripped).not.toContain("startStream('first', …)");
    expect(stripped).not.toContain('// startStream');
  });

  it('tells the declaration apart from a call', () => {
    /* `const startStream = (` must never be counted as a call site, or the arithmetic above is off by one. */
    expect(proxy()).toMatch(/const startStream = \(/);
    expect(codeOnly('const startStream = (\n  kind: RequestKind,\n').match(/startStream\(/g)).toBeNull();
  });

  it('locates every construct it asserts on', () => {
    expect(startStreamBody()).not.toBe('');
    expect(proxy()).toMatch(/computeRequestFingerprint\(/);
    expect(proxy()).toMatch(/const requests: RequestFingerprint\[\] = \[\];/);
  });

  /* The negative assertions must be able to FAIL — a pattern that matches nothing proves nothing. */
  it('its negative matchers are real patterns, not typos', () => {
    expect('requests = [];').toMatch(/requests = \[/);
    expect('requests.splice(0);').toMatch(/requests\.(length = 0|splice|shift|pop)\b/);
    expect('content: computeRequestFingerprint(x)').toMatch(/content:[^\n]*computeRequestFingerprint/);
    expect('maxTokens: 32_000,').toMatch(/maxTokens:\s*\S/);
    expect('maxTokens,').not.toMatch(/maxTokens:\s*\S/);
  });
});
