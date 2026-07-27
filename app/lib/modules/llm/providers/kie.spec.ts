/**
 * KIE's wire-level requirements (SPEC §4.2a).
 *
 * Every rule here fails SILENTLY and costs money. The headline one: without `thinkingFlag`, KIE bills
 * the thinking tokens and returns the text EMPTY — nothing throws, no test fails, and the only symptom
 * is a user watching a dead spinner while we pay full output rate for reasoning nobody can read.
 *
 * NOTE: imports `kie-wire` rather than `KieProvider`, because `base-provider -> manager -> registry ->
 * providers -> base-provider` is an import cycle the bundler tolerates and vitest does not.
 * `anthropic.spec.ts` documents the same cycle and says not to restructure it for a test — hence the
 * wire rules live in their own module, and this drives the REAL ai-sdk against them.
 */
import { createAnthropic } from '@ai-sdk/anthropic';
import { streamText } from 'ai';
import { describe, expect, it } from 'vitest';
import { thinkingFetch } from '~/lib/modules/llm/capabilities';
import { kieFetch, KIE_DEFAULT_BASE_URL, KIE_MODELS } from './kie-wire';

/** A minimal Anthropic SSE stream — enough for `streamText` to consume without erroring. */
function sseResponse(): Response {
  const events = [
    {
      type: 'message_start',
      message: {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-4-6',
        content: [],
        stop_reason: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ];

  return new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

/**
 * Drive the REAL provider stack the way `kie.ts` wires it, and capture what lands on the wire.
 * Asserting on our own intermediate objects would prove nothing — these bugs live between us and KIE.
 */
async function capture(model = 'claude-opus-4-6') {
  const seen: { url?: string; headers?: Record<string, string>; body?: any } = {};

  const spy: typeof fetch = async (input, init) => {
    seen.url = typeof input === 'string' ? input : String((input as Request).url ?? input);
    seen.headers = Object.fromEntries(new Headers(init?.headers ?? {}).entries());
    seen.body = init?.body ? JSON.parse(init.body as string) : undefined;

    return sseResponse();
  };

  const kie = createAnthropic({
    apiKey: 'kie-test-key',
    baseURL: KIE_DEFAULT_BASE_URL,
    headers: { Authorization: 'Bearer kie-test-key' },

    // The exact composition kie.ts uses: kieFetch runs LAST, on the body thinkingFetch already wrote.
    fetch: thinkingFetch('adaptive', 'medium', model, kieFetch(spy)),
  });

  const result = streamText({ model: kie(model), messages: [{ role: 'user', content: 'hi' }] });

  // Drain — the request is not sent until the stream is consumed.
  for await (const _ of result.textStream) {
    void _;
  }

  return seen;
}

describe('the KIE wire format', () => {
  /*
   * 🔴 THE ONE THAT COSTS MONEY SILENTLY.
   *
   * `thinkingFlag` is KIE-proprietary and appears in no Anthropic doc, so nothing about treating KIE as
   * a native passthrough would lead anyone to send it. Measured across 3 streaming trials per model:
   * without it, EVERY KIE model returns thinking blocks with EMPTY text while still billing the
   * thinking tokens. With it, 196/196/196 chars on 4-6.
   */
  it('sends thinkingFlag — without it KIE bills thinking and returns it empty', async () => {
    const seen = await capture();

    expect(seen.body.thinkingFlag).toBe(true);
  });

  /*
   * The flag is an ADDITION, never a replacement — sent alone it does not even enable thinking
   * (measured: thinking_tokens 0). Both must ride the same request, which is what pins the ordering of
   * the two fetch wrappers: thinkingFetch writes the body, kieFetch adds the flag to THAT body.
   */
  it('sends thinkingFlag ALONGSIDE adaptive/summarized thinking, not instead of it', async () => {
    const seen = await capture();

    expect(seen.body.thinkingFlag).toBe(true);
    expect(seen.body.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
    expect(seen.body.output_config?.effort).toBe('medium');
  });

  /*
   * CONTROL. If the assertions above ever pass because nothing reached the wire, or the body stopped
   * being JSON, this fails first and says so. A suite that silently asserts nothing reports a clean
   * bill of health forever.
   */
  it('actually reaches the wire (control for the assertions above)', async () => {
    const seen = await capture();

    expect(seen.body).toBeDefined();
    expect(seen.body.model).toBe('claude-opus-4-6');
    expect(seen.body.messages).toHaveLength(1);
  });

  /*
   * `createAnthropic` only ever sends `x-api-key`, which KIE ignores — every request 401s without an
   * explicit Bearer header. Cheap to lose in a refactor, and instantly total.
   */
  it('authenticates with Authorization: Bearer, which createAnthropic never sends', async () => {
    const seen = await capture();

    expect(seen.headers?.authorization).toBe('Bearer kie-test-key');
  });

  /* The SDK appends `/messages`, so a baseURL without `/v1` POSTs to `/claude/messages` and 404s. */
  it('targets the Anthropic-native messages endpoint under /v1', async () => {
    const seen = await capture();

    expect(KIE_DEFAULT_BASE_URL.endsWith('/v1')).toBe(true);
    expect(seen.url).toBe(`${KIE_DEFAULT_BASE_URL}/messages`);
  });

  /*
   * 🔴 The 4-8 trade, pinned so it stays a DECISION and never decays into an accident.
   *
   * KIE returns no thinking text for `claude-opus-4-8` (0/0/0 measured, even with `thinkingFlag`, while
   * 4-6 gives 196/196/196) — it is the one model they do not document. The owner accepted that on
   * 2026-07-17 to get ~2.34x cheaper generations and a workable 500-credit grant.
   *
   * 4-6 — which DOES return thinking text on KIE — stays OUT until it has a rate row, because an
   * unpriced model bills at the platform model's rates (see the next test).
   */
  it('offers 4-8, whose missing thinking text is a known accepted trade', () => {
    const names = KIE_MODELS.map((m) => m.name);

    expect(names).toContain('claude-opus-4-8');
  });

  /*
   * The default moved to Opus 5 on 2026-07-27 (same price, same honest cache accounting, same missing
   * thinking text — probe-verified, see kie-wire.ts). It MUST be listed, not merely priced: an
   * unlisted default silently runs `modelsList[0]` on the enhancer path while settlement charges the
   * configured model's rates.
   */
  it('offers claude-opus-5, the platform default since 2026-07-27', () => {
    const names = KIE_MODELS.map((m) => m.name);

    expect(names).toContain('claude-opus-5');
  });

  /*
   * ⚠️ `ratesFor` falls back to the PLATFORM model's rates for an unknown model, so every model offered
   * here must be priced explicitly or it bills at 4-8's rates — measured: 4-6 and 4-5 are priced
   * DIFFERENTLY. That would over-charge users and throw nothing. This is the `packMargin` shape of bug:
   * two files, each internally sensible, disagreeing about what something costs.
   */
  it('prices every model it offers — an unpriced model silently bills at the platform model rate', async () => {
    const { KIE_MODEL_RATES } = await import('~/lib/.server/billing/rates');

    for (const model of KIE_MODELS) {
      expect(KIE_MODEL_RATES[model.name], `${model.name} is offered on KIE but has no rate row`).toBeDefined();
    }
  });
});

describe('kieFetch', () => {
  /* A rewrite must never be the thing that breaks a generation — same rule as `thinkingFetch`. */
  it('passes a non-JSON body through untouched rather than throwing', async () => {
    let reached = false;
    const pass: typeof fetch = async () => {
      reached = true;
      return new Response('ok');
    };

    await kieFetch(pass)('https://x.test', { method: 'POST', body: 'not json at all' });
    expect(reached).toBe(true);
  });

  it('leaves a bodyless request alone', async () => {
    let seenInit: any;
    const pass: typeof fetch = async (_i, init) => {
      seenInit = init;
      return new Response('ok');
    };

    await kieFetch(pass)('https://x.test', { method: 'GET' });
    expect(seenInit?.body).toBeUndefined();
  });
});
