/**
 * THE RECORD OF WHAT WE SENT IS ONLY WORTH KEEPING IF IT IS STABLE, EMPTY AND SENSITIVE (SPEC §4.2
 * step 2a, §4.2.8) — and each of those three fails in a different, silent direction.
 *
 * `request-fingerprint.ts` exists because every model-visibility incident in this codebase was found by
 * a person noticing afterwards that the model had behaved as if it could not see something: the
 * 7-files-not-78 mount race, the double-keyed file map that showed 14 files twice for weeks, the history
 * carrying stale file bodies. None threw. The input token count moved in a direction that reads as
 * ordinary. The fingerprint is what makes those answerable after the fact.
 *
 * So the failures this suite prevents are the ones that would quietly retire the guard:
 *
 * 1. 🔴 **AN UNSTABLE HASH MUTES THE ALERT INSIDE A DAY.** If two structurally identical requests
 *    fingerprint differently because some upstream built an object's keys in another order, every
 *    comparison downstream is a false positive — and an alert that cries wolf is turned off, at which
 *    point it is indistinguishable from never having existed. Hence the determinism tests build the SAME
 *    request twice with genuinely different key insertion order, and assert the two inputs really do
 *    differ (a determinism test over two identical inputs proves nothing).
 *
 * 2. 🔴 **A FINGERPRINT THAT CARRIES BODIES IS SERVER-SIDE PROJECT STORAGE UNDER A NEW NAME.** That is
 *    what §4.5.4b, migration 0007 and `no-server-storage.spec.ts` exist to prevent, and it would arrive
 *    here as one field somebody added to make a diff readable. The no-bodies test plants a canary in a
 *    manifest path, a user message and a system block, then asserts the serialized fingerprint does not
 *    contain it. ⚠️ It was MUTATION-VERIFIED: adding a `debugText` field carrying a system block's raw
 *    content makes it fail. A no-bodies test that cannot fail is not a test.
 *
 * 3. 🔴 **A HASH THAT NEVER CHANGES PASSES EVERY OTHER TEST IN THIS FILE.** `sha256(() => 'constant')`
 *    is deterministic and carries no bodies; it is also useless. The sensitivity block is the control
 *    that makes the rest mean something: one character of a system block moves that block's hash and no
 *    other, a manifest entry's SIZE moves the manifest hash, and reordering the manifest does not.
 */
import { Buffer } from 'node:buffer';
import type { CoreMessage } from 'ai';
import { describe, expect, it } from 'vitest';
import { computeRequestFingerprint, type RequestFingerprintInput, type RequestKind } from './request-fingerprint';
import { IMAGE_TOKENS_UPPER_BOUND } from '~/lib/.server/llm/history';

/**
 * The assembled array is built by six different call sites out of blocks, notes and history. A spec that
 * could only express ONE key order could not see the bug the canonicaliser's sort exists to prevent, so
 * the cast is deliberate: these are the shapes that really arrive, not the shapes the types encourage.
 */
const message = (value: Record<string, unknown>): CoreMessage => value as unknown as CoreMessage;

const input = (overrides: Partial<RequestFingerprintInput> = {}): RequestFingerprintInput => ({
  kind: 'first',
  messages: [],
  toolNames: [],
  toolChoice: 'omitted',
  maxSteps: 1,
  maxTokens: 64000,
  model: 'claude-sonnet-5',
  ...overrides,
});

/** Recognisable enough that a partial leak — a substring, a truncation — still trips the assertion. */
const SECRET = 'SUPER-SECRET-CANARY-9f3a';

describe('determinism — the same request fingerprints identically however its objects were built', () => {
  const built = () =>
    input({
      messages: [
        message({
          role: 'system',
          content: 'You are a Babylon Toolkit builder.',
          providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
        }),
        message({ role: 'user', content: [{ type: 'text', text: 'add a boost pad to the track' }] }),
        message({
          role: 'assistant',
          content: [
            { type: 'text', text: 'Loading the design skill.' },
            { type: 'tool-call', toolCallId: 'c1', toolName: 'load_skill', args: { name: 'bt-design' } },
          ],
        }),
      ],
      toolNames: ['load_skill', 'generate_image'],
      manifest: [{ path: 'src/scripts/KartMode.ts', size: 4096, kind: 'text' }],
    });

  /* Byte-for-byte the same request. Every object below has its keys inserted in a different order. */
  const shuffled = () =>
    input({
      messages: [
        message({
          providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
          content: 'You are a Babylon Toolkit builder.',
          role: 'system',
        }),
        message({ content: [{ text: 'add a boost pad to the track', type: 'text' }], role: 'user' }),
        message({
          content: [
            { text: 'Loading the design skill.', type: 'text' },
            { args: { name: 'bt-design' }, toolName: 'load_skill', toolCallId: 'c1', type: 'tool-call' },
          ],
          role: 'assistant',
        }),
      ],
      toolNames: ['load_skill', 'generate_image'],
      manifest: [{ kind: 'text', size: 4096, path: 'src/scripts/KartMode.ts' }],
    });

  /**
   * ⚠️ THE CONTROL. Without this, two accidentally-identical inputs would make the determinism
   * assertion below vacuous — it would pass for a canonicaliser with no sort at all.
   */
  it('the two inputs genuinely differ in key order — otherwise the next test proves nothing', () => {
    expect(JSON.stringify(built())).not.toBe(JSON.stringify(shuffled()));
  });

  it('produces a byte-identical fingerprint from both', () => {
    const a = JSON.stringify(computeRequestFingerprint(built()));
    const b = JSON.stringify(computeRequestFingerprint(shuffled()));

    expect(a, 'an unstable hash makes every comparison a false positive, which mutes the alert').toBe(b);
  });

  /*
   * The fingerprint is computed AFTER assembly over arrays the caller still owns — the tool object's
   * keys and the manifest. A sort in place would reorder the caller's data as a side effect of
   * observing it, which is the one thing a diagnostic may never do.
   */
  it('sorts nothing in place — the arrays it is handed come back untouched', () => {
    const toolNames = ['load_skill', 'generate_image'];
    const manifest = [
      { path: 'src/main.ts', size: 10, kind: 'text' },
      { path: 'public/hero.png', size: 20, kind: 'binary' },
    ];

    computeRequestFingerprint(input({ toolNames, manifest }));

    expect(toolNames).toEqual(['load_skill', 'generate_image']);
    expect(manifest.map((entry) => entry.path)).toEqual(['src/main.ts', 'public/hero.png']);
  });
});

describe('no bodies — the fingerprint answers "did this change?" and nothing else', () => {
  const withCanaries = () =>
    input({
      messages: [
        message({ role: 'system', content: `# Project instructions\nThe passphrase is ${SECRET}.` }),
        message({ role: 'user', content: [{ type: 'text', text: `deploy using ${SECRET}` }] }),
      ],
      manifest: [{ path: `src/scripts/${SECRET}.ts`, size: 128, kind: 'text' }],
    });

  /* ⚠️ If the planting ever stops reaching the module, the leak test below goes green for free. */
  it('the canaries really are in the input', () => {
    expect(JSON.stringify(withCanaries())).toContain(SECRET);
  });

  it('carries no system block body, no message text and no manifest path', () => {
    const serialized = JSON.stringify(computeRequestFingerprint(withCanaries()));

    expect(serialized, 'recording the request would make this feature server-side project storage').not.toContain(
      SECRET,
    );

    /* And it is not merely empty — it did observe all three, as lengths and hashes. */
    const fingerprint = computeRequestFingerprint(withCanaries());
    expect(fingerprint.systemBlocks[0].chars).toBeGreaterThan(0);
    expect(fingerprint.messages.chars).toBeGreaterThan(0);
    expect(fingerprint.manifest.entries).toBe(1);
  });
});

describe('attachments by reference — measured, never walked', () => {
  /* 20MB of image payload may ride on a turn. Hashing it costs real money for zero information. */
  const secretBytes = new TextEncoder().encode(`png-payload:${SECRET}`);
  const base64Secret = Buffer.from(`file-payload:${SECRET}`, 'utf8').toString('base64');

  const withAttachments = () =>
    input({
      messages: [
        message({
          role: 'user',
          content: [
            { type: 'text', text: 'match this style' },
            { type: 'image', image: secretBytes },
            { type: 'file', mimeType: 'application/pdf', data: base64Secret },
          ],
        }),
      ],
    });

  it('the payloads really do contain the canary', () => {
    expect(new TextDecoder().decode(secretBytes)).toContain(SECRET);
    expect(Buffer.from(base64Secret, 'base64').toString('utf8')).toContain(SECRET);
  });

  it('never lets an attachment byte reach the serialized fingerprint', () => {
    const serialized = JSON.stringify(computeRequestFingerprint(withAttachments()));

    expect(serialized).not.toContain(SECRET);
    expect(serialized, 'nor the base64 spelling of it').not.toContain(base64Secret);
  });

  it('reports the count and an upper bound on the tokens, never the bytes', () => {
    const fingerprint = computeRequestFingerprint(withAttachments());

    expect(fingerprint.attachments.count).toBe(2);

    /*
     * The image is the flat upper bound (`IMAGE_TOKENS_UPPER_BOUND`); the PDF is its length over
     * four. Byte size is the measure `history.ts` documents as WRONG for this question — "a 5MB photo
     * and a 5MB screenshot of flat colour cost wildly different amounts to store and nearly the same
     * to look at" — so a record denominated in bytes would be misleading in the one direction that
     * matters for a spend indicator.
     */
    expect(fingerprint.attachments.tokens).toBe(IMAGE_TOKENS_UPPER_BOUND + Math.ceil(base64Secret.length / 4));
  });

  /*
   * 🔴 THE ASSERTION THAT CAN ACTUALLY FAIL — and the reason the grep above cannot.
   *
   * A payload folded into a hash INPUT never appears in the hash OUTPUT, so "the serialized
   * fingerprint does not contain the secret" stays green even if every attachment byte is being
   * hashed on every turn. Two attachments of EQUAL LENGTH and DIFFERENT BYTES are the only shape that
   * distinguishes "measured" from "walked": if the payload reached the hash, these two differ.
   *
   * Verified by mutation: disabling the attachment refusal in `canonicalize` leaves the grep test
   * green and fails this one.
   */
  it('produces the same hash for two equal-length attachments with different bytes', () => {
    const withPayload = (byte: number) =>
      computeRequestFingerprint(
        input({
          messages: [
            message({
              role: 'user',
              content: [
                { type: 'text', text: 'same text' },
                { type: 'image', image: new Uint8Array(64).fill(byte) },
                { type: 'file', mimeType: 'application/pdf', data: String.fromCharCode(byte + 65).repeat(40) },
              ],
            }),
          ],
        }),
      );

    const a = withPayload(1);
    const b = withPayload(2);

    expect(a.messages.sha256, 'an attachment payload must never reach a hash input').toBe(b.messages.sha256);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  /*
   * 🔴 `chars` is a TEXT measure. Folding attachment bytes into it would make an image turn look like a
   * 20-million-character conversation, i.e. the one number a mismatch report reads would be nonsense.
   */
  it('does not let attachment payloads contribute to messages.chars', () => {
    const fingerprint = computeRequestFingerprint(withAttachments());

    expect(fingerprint.messages.chars).toBe('match this style'.length);
  });
});

describe('system blocks are picked out by ROLE, not by position', () => {
  /**
   * 🔴 THE TOOL-FREE RETRY SHAPE. It splices a synthetic media-recap block BETWEEN the system array and
   * the conversation. A positional split files that block as a MESSAGE — which is exactly the difference
   * the fingerprint exists to make visible, so the guard would hide the thing it watches for.
   */
  const spliced = () =>
    input({
      kind: 'provider-retry-tool-free',
      messages: [
        message({ role: 'system', content: 'base prompt' }),
        message({ role: 'user', content: 'build me a kart racer' }),
        message({ role: 'system', content: '# Media already generated for this request' }),
        message({ role: 'user', content: 'continue' }),
      ],
    });

  it('files a mid-conversation system block under systemBlocks', () => {
    const fingerprint = computeRequestFingerprint(spliced());

    expect(fingerprint.systemBlocks).toHaveLength(2);
    expect(fingerprint.messages.count).toBe(2);
  });

  it('fingerprints the spliced block in order, as itself', () => {
    const fingerprint = computeRequestFingerprint(spliced());

    expect(fingerprint.systemBlocks[1].chars).toBe('# Media already generated for this request'.length);
    expect(fingerprint.systemBlocks[1].sha256).not.toBe(fingerprint.systemBlocks[0].sha256);
  });
});

describe('breakpointCount', () => {
  /*
   * The API's hard max is four and a fifth is an HTTP 400 before a single token — a whole dead
   * generation. This count is computed every turn and, until now, thrown away.
   */
  it('counts every message carrying providerOptions, matching countCacheBreakpoints', () => {
    const fingerprint = computeRequestFingerprint(
      input({
        messages: [
          message({ role: 'system', content: 'base', providerOptions: { anthropic: {} } }),
          message({ role: 'system', content: 'starter files' }),
          message({ role: 'system', content: 'docs', providerOptions: { anthropic: {} } }),
          message({ role: 'user', content: 'go', providerOptions: { anthropic: {} } }),
        ],
      }),
    );

    /*
     * 🔴 THREE, not two. `countCacheBreakpoints` filters the WHOLE array, and the API's four-block
     * ceiling counts `cache_control` wherever it appears — a user message included. Counting only the
     * system blocks would UNDER-report against that ceiling, which is the wrong direction for a field
     * whose one job is to make a regression visible before it is an HTTP 400 and a dead generation.
     *
     * Every assignment in `proxy.ts` today happens to be on a system block. "Today" is not a
     * guarantee, and agreeing with the enforcing function costs nothing.
     */
    expect(fingerprint.breakpointCount, 'the ceiling counts cache_control on ANY message').toBe(3);
    expect(fingerprint.systemBlocks.map((block) => block.hasBreakpoint)).toEqual([true, false, true]);
  });

  /*
   * The two implementations of one rule, agreeing. `countCacheBreakpoints` lives in `proxy.ts` (which
   * cannot be imported here — it boots a provider), so this pins the PREDICATE rather than the
   * function: `providerOptions !== undefined`, over every message.
   */
  it('applies the same predicate the proxy enforces the budget with', () => {
    const messages = [
      message({ role: 'system', content: 'a', providerOptions: { anthropic: {} } }),
      message({ role: 'system', content: 'b' }),
      message({ role: 'user', content: 'c', providerOptions: { anthropic: {} } }),
    ];
    const proxyRule = messages.filter((m) => (m as { providerOptions?: unknown }).providerOptions !== undefined).length;

    expect(computeRequestFingerprint(input({ messages })).breakpointCount).toBe(proxyRule);
  });

  /* An explicitly-`undefined` key is the shape an optional spread leaves behind. It is not a breakpoint. */
  it('treats an explicit undefined as no breakpoint', () => {
    const fingerprint = computeRequestFingerprint(
      input({ messages: [message({ role: 'system', content: 'base', providerOptions: undefined })] }),
    );

    expect(fingerprint.breakpointCount).toBe(0);
  });
});

describe('toolNames', () => {
  /* The tool object's key order is CONSTRUCTION order, which changes with the turn's policy. */
  it('is sorted regardless of the order the tool set was built in', () => {
    const forward = computeRequestFingerprint(
      input({ toolNames: ['load_skill', 'generate_image', 'evaluate_in_game'] }),
    );
    const reverse = computeRequestFingerprint(
      input({ toolNames: ['evaluate_in_game', 'generate_image', 'load_skill'] }),
    );

    expect(forward.toolNames).toEqual(['evaluate_in_game', 'generate_image', 'load_skill']);
    expect(reverse.toolNames).toEqual(forward.toolNames);
  });
});

/**
 * 🔴 THE CONTROL BLOCK. Everything above passes for a hash function that returns a constant: a constant
 * is perfectly deterministic and leaks nothing. These are the assertions that make the rest mean
 * something — the hash must MOVE when the thing it identifies moves.
 */
describe('sensitivity — the hash changes when it should', () => {
  const withSystem = (first: string, second: string) =>
    input({ messages: [message({ role: 'system', content: first }), message({ role: 'system', content: second })] });

  it('one character of a system block changes that block, and only that block', () => {
    const before = computeRequestFingerprint(withSystem('You are a builder.', 'starter files'));
    const after = computeRequestFingerprint(withSystem('You are a Builder.', 'starter files'));

    expect(after.systemBlocks[0].sha256).not.toBe(before.systemBlocks[0].sha256);
    expect(after.systemBlocks[1].sha256, 'an untouched block must not move, or diffs name every block').toBe(
      before.systemBlocks[1].sha256,
    );
  });

  it('one character of a message changes messages.sha256', () => {
    const before = computeRequestFingerprint(
      input({ messages: [message({ role: 'user', content: 'add a boost pad' })] }),
    );
    const after = computeRequestFingerprint(
      input({ messages: [message({ role: 'user', content: 'add a boost pod' })] }),
    );

    expect(after.messages.sha256).not.toBe(before.messages.sha256);
  });

  /*
   * SIZE, not just path: the double-keyed file map showed the same paths — what a diff had to catch was
   * the listing changing underneath an unchanged-looking set of names.
   */
  it("a manifest entry's size changes manifest.sha256", () => {
    const before = computeRequestFingerprint(input({ manifest: [{ path: 'src/main.ts', size: 100, kind: 'text' }] }));
    const after = computeRequestFingerprint(input({ manifest: [{ path: 'src/main.ts', size: 101, kind: 'text' }] }));

    expect(after.manifest.sha256).not.toBe(before.manifest.sha256);
  });

  /*
   * ...but the manifest arrives in watcher-arrival order, which a reload reshuffles. Hashing that order
   * would report a change on every reload — noise, and then a muted alert.
   */
  it('reordering the manifest does not change manifest.sha256', () => {
    const entries = [
      { path: 'src/main.ts', size: 100, kind: 'text' },
      { path: 'public/hero.png', size: 900, kind: 'binary' },
      { path: 'src/babylon/globals.ts', size: 50, kind: 'text' },
    ];

    const forward = computeRequestFingerprint(input({ manifest: entries }));
    const reverse = computeRequestFingerprint(input({ manifest: [...entries].reverse() }));

    expect(reverse.manifest.sha256).toBe(forward.manifest.sha256);
    expect(reverse.manifest.entries).toBe(3);
  });
});

describe('the scalars round-trip', () => {
  /**
   * A turn makes one request and can re-issue for five distinct reasons — six `RequestKind` values,
   * six request shapes — and until now no persisted record said what any of them SENT.
   * (`finish_reason` has named WHICH re-issue ran since migration 0002; the request itself, never.) Collapsing them loses precisely the fact this exists to
   * expose — so every declared kind must survive, not just the ones a test author thought of.
   */
  const kinds: RequestKind[] = [
    'first',
    'provider-retry',
    'provider-retry-tool-free',
    'forced-continuation',
    'unproductive-rescue',
    'creation-completeness',
  ];

  it.each(kinds)('carries kind %s through unchanged', (kind) => {
    expect(computeRequestFingerprint(input({ kind })).kind).toBe(kind);
  });

  it('carries the per-turn decisions that were previously unrecoverable from the record', () => {
    const fingerprint = computeRequestFingerprint(
      input({
        toolChoice: 'none',
        maxSteps: 7,
        maxTokens: 64000,
        model: 'claude-opus-5',
        provider: 'Comet',
        effort: 'xhigh',
        thinkingMode: 'disabled',
      }),
    );

    expect(fingerprint.toolChoice).toBe('none');
    expect(fingerprint.maxSteps).toBe(7);
    expect(fingerprint.maxTokens).toBe(64000);
    expect(fingerprint.model, 'the model REQUESTED — a refusal fallback may swap the one that SERVES').toBe(
      'claude-opus-5',
    );
    expect(fingerprint.provider).toBe('Comet');
    expect(fingerprint.effort).toBe('xhigh');
    expect(fingerprint.thinkingMode).toBe('disabled');
  });
});
