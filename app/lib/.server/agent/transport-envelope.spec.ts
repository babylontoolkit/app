/**
 * The transport envelope must be stripped ONCE, at the top of the proxy, and the raw form must never be
 * read again (SPEC §4.11, `spec/context-budget.md` pathology 12).
 *
 * ## Why this is a SOURCE scan and not only a behavioural test
 *
 * The demo failure was not caused by a missing check — it was caused by a reader that did not know its
 * input had been wrapped. Stripping fixed that reader. It did nothing to stop the NEXT one: any future
 * line that reaches for `request.messages` gets the enveloped form back, and whatever decision it makes
 * from it is wrong in the same silent way (no error, no log, and — as measured — a full-price generation
 * that does nothing).
 *
 * So the guard is default-deny and structural, the shape `spec/spend-holes.md` argues for after the same
 * lesson twice: there is exactly ONE permitted mention of `request.messages` in the proxy — the
 * normalization itself — and this fails if a second appears. The safe state is the one that needs no
 * judgement from whoever edits the file next.
 *
 * ⚠️ A scan that silently matches nothing reports a clean bill of health forever (`no-server-storage.spec.ts`
 * learned this), so the CONTROL below proves the scanner still sees what it is looking for.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  countUnstrippedEnvelopes,
  looksLikeUnstrippedEnvelope,
  stripTransportEnvelopes,
} from '~/lib/chat/message-envelope';

const PROXY = readFileSync(path.join(process.cwd(), 'app/lib/.server/agent/proxy.ts'), 'utf8');

/** Strip comments — a `request.messages` inside a doc comment is prose, not a read. */
const PROXY_CODE = PROXY.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('the proxy reads the raw request messages exactly ONCE', () => {
  it('has a single `request.messages` read — the normalization', () => {
    const reads = PROXY_CODE.match(/request\.messages/g) ?? [];

    expect(reads).toHaveLength(1);
  });

  it('and that one read is the one that strips the envelope', () => {
    expect(PROXY_CODE).toMatch(/stripTransportEnvelopes\(request\.messages\)/);
  });

  /* CONTROL: the scanner can actually find these strings, so a passing run above means something. */
  it('control — the scanner finds a known reference and ignores commented-out ones', () => {
    expect(PROXY_CODE).toContain('stripTransportEnvelopes');
    expect(PROXY_CODE.match(/request\.messages/g)?.length).toBeGreaterThan(0);
    expect(PROXY.match(/request\.messages/g)!.length).toBeGreaterThan(PROXY_CODE.match(/request\.messages/g)!.length);
  });

  it('routes the drift tripwire to monitoring, not just to a log file', () => {
    expect(PROXY_CODE).toMatch(/countUnstrippedEnvelopes/);
    expect(PROXY_CODE).toMatch(/scope: 'transport-envelope'/);
  });
});

/**
 * The tripwire exists for FORMAT DRIFT: upstream changes the envelope, the strict stripper stops
 * matching, and the demo failure returns silently. A detector built from the stripper's own regex cannot
 * see that, so these cases are all things the STRIPPER deliberately misses.
 */
describe('the drift tripwire sees what the stripper cannot', () => {
  it.each([
    ['a single newline instead of two', '[Model: claude-opus-4-8]\n[Provider: KIE]\n/bt-spec add auth'],
    ['an `=` instead of `: `', '[Model=claude-opus-4-8]\n\n/bt-spec add auth'],
    ['the provider tag first', '[Provider: KIE]\n\n[Model: claude-opus-4-8]\n\n/bt-spec add auth'],
    ['leading whitespace', '  [Model: claude-opus-4-8]\n\n/bt-spec add auth'],
  ])('flags %s', (_label, drifted) => {
    // The strict stripper leaves these (wholly or partly) in place...
    const [stripped] = stripTransportEnvelopes([{ role: 'user', content: drifted }]);

    // ...and the loose tripwire is what notices.
    expect(looksLikeUnstrippedEnvelope(stripped.content as string)).toBe(true);
    expect(countUnstrippedEnvelopes([stripped])).toBe(1);
  });

  it('stays quiet on a correctly stripped message', () => {
    const [stripped] = stripTransportEnvelopes([
      { role: 'user', content: '[Model: claude-opus-4-8]\n\n[Provider: KIE]\n\n/bt-spec add auth' },
    ]);

    expect(stripped.content).toBe('/bt-spec add auth');
    expect(countUnstrippedEnvelopes([stripped])).toBe(0);
  });

  it('stays quiet on ordinary prose, including a bracketed opening', () => {
    expect(looksLikeUnstrippedEnvelope('add a boost pad')).toBe(false);
    expect(looksLikeUnstrippedEnvelope('[note] make the header bigger')).toBe(false);
  });

  it('never counts assistant messages — only what the client wraps', () => {
    expect(countUnstrippedEnvelopes([{ role: 'assistant', content: '[Model: x] I wrote that' }])).toBe(0);
  });
});
