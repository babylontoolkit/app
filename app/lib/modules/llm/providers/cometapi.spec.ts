/**
 * Comet's wire facts (SPEC §4.2a, `_specs/cometapi-provider_plan.md` T2).
 *
 * `cometapi-dispatch.spec.ts` pins WHICH wire each family takes. This file pins what those wires are:
 * the Claude request as it actually lands on `api.cometapi.com`, the `/v1beta` derivation Gemini needs,
 * and the shipped model list.
 *
 * The rules here fail the way every rule in `spec/context-budget.md` fails — silently, and in money.
 * The headline one is `output_config.effort`: omitting it is not "no opinion", it is the server-side
 * default of `high` on every generation, with the token count going DOWN because the reasoning comes
 * back as empty text. Nothing throws and no test fails unless one is written for it.
 *
 * NOTE: imports `comet-wire` rather than `CometApiProvider`, because
 * `base-provider -> manager -> registry -> providers -> base-provider` is an import cycle the bundler
 * tolerates and vitest does not (`kie.spec.ts` and `anthropic.spec.ts` both document it and both say
 * not to restructure it for a test). Hence the wire facts live in their own module and this drives the
 * REAL ai-sdk against them.
 */
import { createAnthropic } from '@ai-sdk/anthropic';
import { streamText } from 'ai';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { thinkingFetch } from '~/lib/modules/llm/capabilities';
import { FAMILY_POLICY, familyOf } from '~/lib/modules/llm/model-families';
import { rateLimitFetch } from '~/lib/modules/llm/rate-limit';
import { cometEnvModel, cometGeminiBaseUrl, COMET_DEFAULT_BASE_URL, COMET_MODELS, COMET_WIRES } from './comet-wire';
import { DEFAULT_MODEL } from '~/utils/constants';
import { DEFAULT_PREMIUM_MODEL } from '~/lib/.server/billing/model-tiers'; // pure data, zero imports — safe from a spec

/**
 * ⚠️ FILE-WIDE, not per-describe. `cometEnvModel` falls back to `process.env` when `serverEnv` does
 * not carry a key, and vitest loads `.env.local` — which on this machine holds a REAL Comet key and may
 * hold `LLM_MODEL`. An unscrubbed spec resolves the developer's live configuration and then fails on
 * their machine only, with CI green, blaming code they did not touch. That is the `oauth.spec.ts` trap,
 * and it is scrubbed here rather than in the one describe that obviously reads env because the next
 * describe someone adds will not be that one.
 */
beforeEach(() => {
  for (const key of ['LLM_MODEL', 'COMET_DEFAULT_MODEL', 'COMET_API_KEY', 'COMET_BASE_URL']) {
    vi.stubEnv(key, undefined as unknown as string);
  }
});

/** A minimal Anthropic SSE stream — enough for `streamText` to consume without erroring. */
function sseResponse(): Response {
  const events = [
    {
      type: 'message_start',
      message: {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-5',
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
 * Drive the REAL provider stack the way `cometapi.ts`'s Claude branch wires it, and capture what lands
 * on the wire. Asserting on our own intermediate objects would prove nothing — these bugs live between
 * us and Comet.
 */
async function capture(model = 'claude-opus-5') {
  const seen: { url?: string; headers?: Record<string, string>; body?: any } = {};

  const spy: typeof fetch = async (input, init) => {
    seen.url = typeof input === 'string' ? input : String((input as Request).url ?? input);
    seen.headers = Object.fromEntries(new Headers(init?.headers ?? {}).entries());
    seen.body = init?.body ? JSON.parse(init.body as string) : undefined;

    return sseResponse();
  };

  const comet = createAnthropic({
    apiKey: 'comet-test-key',
    baseURL: COMET_DEFAULT_BASE_URL,
    headers: { Authorization: 'Bearer comet-test-key' },

    /*
     * The exact composition `cometapi.ts` uses — and note what is NOT here: KIE's `kieFetch` layer.
     * `rateLimitFetch` sits closest to the network because it is the only wrapper that decides whether
     * to send the finished body AGAIN, so it must see the request exactly as the vendor will.
     */
    fetch: thinkingFetch('adaptive', 'medium', model, rateLimitFetch({ provider: 'Comet' }, spy)),
  });

  const result = streamText({ model: comet(model), messages: [{ role: 'user', content: 'hi' }] });

  // Drain — the request is not sent until the stream is consumed.
  for await (const _ of result.textStream) {
    void _;
  }

  return seen;
}

describe('the Comet Claude wire format', () => {
  /*
   * 🔴 THE ONE THAT COSTS MONEY SILENTLY.
   *
   * `display: 'summarized'` costs nothing extra and is the whole point of enabling thinking; the
   * default (`omitted`) bills every reasoning token at the full output rate and hands back a thinking
   * block whose text is EMPTY — measured as 90s of dead spinner on the direct provider. And
   * `output_config.effort` defaults to `high` SERVER-SIDE, so sending nothing buys the
   * second-most-expensive setting on every generation.
   *
   * Comet is a native Anthropic passthrough, so both facts apply here unchanged — which is precisely
   * why they need their own assertion: "it is the same as Anthropic" is an expectation, not a test.
   */
  it('sends adaptive/summarized thinking AND an explicit effort', async () => {
    const seen = await capture();

    expect(seen.body.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
    expect(seen.body.output_config?.effort).toBe('medium');
  });

  /*
   * 🔴 AND IT MUST NOT SEND KIE'S FLAG.
   *
   * `thinkingFlag` is private to KIE's Claude adapter and appears in no Anthropic document. It is in
   * this file rather than only in the dispatch spec because the regression path runs straight through
   * here: someone reads `kie.spec.ts`'s emphatic "without this, KIE bills thinking and returns it
   * empty", concludes the platform needs it, and adds `kieFetch` to the chain above.
   */
  it('does NOT send thinkingFlag — that field belongs to KIE’s adapter, not to a passthrough', async () => {
    const seen = await capture();

    expect(seen.body.thinkingFlag).toBeUndefined();
  });

  /*
   * CONTROL. If the assertions above ever pass because nothing reached the wire, or the body stopped
   * being JSON, this fails first and says so. A suite that silently asserts nothing reports a clean
   * bill of health forever.
   */
  it('actually reaches the wire (control for the assertions above)', async () => {
    const seen = await capture();

    expect(seen.body).toBeDefined();
    expect(seen.body.model).toBe('claude-opus-5');
    expect(seen.body.messages).toHaveLength(1);
  });

  /*
   * `createAnthropic({apiKey})` only ever sends `x-api-key`. Comet accepts that too — so unlike KIE,
   * losing this header is NOT instantly total, which is what makes it worth pinning: the failure would
   * be invisible until the day someone debugs an auth problem against the one header shape every other
   * branch sends.
   */
  it('authenticates with Authorization: Bearer, which createAnthropic never sends', async () => {
    const seen = await capture();

    expect(seen.headers?.authorization).toBe('Bearer comet-test-key');
  });

  /*
   * 🔴 THE `/v1` SUFFIX IS THE VIABILITY TEST, NOT A DETAIL.
   *
   * The SDK appends `/messages`, so a base without `/v1` POSTs to a path that does not exist. More to
   * the point, `/v1/messages` is Anthropic's NATIVE Messages API — the only surface on this gateway
   * that can carry `cache_control`. Routing Claude traffic to an OpenAI-compatible
   * `/v1/chat/completions` shim would silently disable every breakpoint in `spec/context-budget.md`
   * and cost ~3x on every edit turn, with identical bytes returned and nothing thrown.
   */
  it('targets the Anthropic-native messages endpoint under /v1', async () => {
    expect(COMET_DEFAULT_BASE_URL.endsWith('/v1')).toBe(true);
    expect(COMET_DEFAULT_BASE_URL).not.toContain('/chat/completions');

    const seen = await capture();

    expect(seen.url).toBe(`${COMET_DEFAULT_BASE_URL}/messages`);
  });
});

describe('cometGeminiBaseUrl', () => {
  /*
   * Gemini rides `/v1beta`, not `/v1` — Google's own versioning, which Comet mirrors. `@ai-sdk/google`
   * appends `/models/<id>:...`, so this must end at the version segment or every Gemini request 404s.
   *
   * It is DERIVED from the configured base rather than a second constant, so an operator who points
   * `COMET_BASE_URL` at a proxy gets their Gemini traffic proxied too. A hardcoded second URL would
   * send that one family straight past the proxy, silently — the same shape as `KIE_BASE_URL`'s
   * family-scoping trap, pointing the other way.
   */
  it('turns a /v1 base into /v1beta rather than appending a second version segment', () => {
    expect(cometGeminiBaseUrl('https://api.cometapi.com/v1')).toBe('https://api.cometapi.com/v1beta');
  });

  /* A trailing slash is an ordinary thing for an operator to paste, and must not produce `/v1/beta`. */
  it('tolerates a trailing slash', () => {
    expect(cometGeminiBaseUrl('https://api.cometapi.com/v1/')).toBe('https://api.cometapi.com/v1beta');
    expect(cometGeminiBaseUrl('https://proxy.internal/comet/')).toBe('https://proxy.internal/comet/v1beta');
  });

  /*
   * A base whose shape we cannot parse is LEFT ALONE and `/v1beta` appended — the honest fallback.
   * Rewriting an unrecognised tail would be guessing at an operator's proxy layout, and a wrong guess
   * here is a 404 on a URL they never typed.
   */
  it('appends /v1beta to a base with no recognisable version segment', () => {
    expect(cometGeminiBaseUrl('https://proxy.internal/comet')).toBe('https://proxy.internal/comet/v1beta');
  });

  /*
   * CONTROL: the function must actually be transforming the input. Every assertion above is satisfied
   * by a function that ignores its argument and returns a constant, which is exactly the regression
   * that would break the proxy case while leaving the default one green.
   */
  it('derives from the argument rather than returning a constant (control)', () => {
    const a = cometGeminiBaseUrl('https://one.test/v1');
    const b = cometGeminiBaseUrl('https://two.test/v1');

    expect(a).not.toBe(b);
    expect(a).toContain('one.test');
    expect(b).toContain('two.test');
  });
});

describe('COMET_MODELS', () => {
  /*
   * 🔴 EVERY SHIPPED ROW CARRIES 1M/128k — AND THE ONE ID THAT WOULD NOT IS NOT SHIPPED.
   *
   * This test used to pin Haiku's 200k/64k as the family's exception. T5's per-id re-probe removed the
   * row: `claude-haiku-4-5` answers a hard **400** on Comet ("has not been priced by the
   * administrator yet") and Comet serves the dated `claude-haiku-4-5-20251001` instead, at an output
   * cap its feed reports as **8K**. So the exception is not merely absent, it is absent for a reason
   * that must not be undone by a helpful edit — the full evidence lives in
   * `app/lib/.server/billing/comet-prices.spec.ts`, which pins the absence from the pricing side.
   *
   * ⚠️ The lesson the old test carried is kept, pointed FORWARD: a Haiku row added later must bring its
   * OWN caps, not inherit these. The safe-looking refactor — spread one shared constant across the list
   * — is the bug, because every row would still be right except the one that 400s, and only on the
   * generations that ran long.
   */
  it('pins every row’s caps explicitly — no shared constant, and no Haiku row to inherit them', () => {
    expect(COMET_MODELS.length).toBeGreaterThan(0);

    for (const model of COMET_MODELS) {
      expect(model.maxTokenAllowed, `${model.name}'s context cap`).toBe(1_000_000);
      expect(model.maxCompletionTokens, `${model.name}'s output cap`).toBe(128_000);
    }

    expect(
      COMET_MODELS.map((m) => m.name),
      'Haiku 400s on this provider — a row here would inherit caps it does not have',
    ).not.toContain('claude-haiku-4-5');
  });

  /*
   * Every row must claim THIS provider. `getProviderBaseUrlAndKey` and the tier ladder both resolve a
   * model through its provider name, so a row mislabelled during a copy from `KIE_MODELS` would be
   * offered by Comet and looked up against KIE's key and price list.
   */
  it('labels every row as Comet', () => {
    expect(COMET_MODELS.length).toBeGreaterThan(0);

    for (const model of COMET_MODELS) {
      expect(model.provider, `${model.name} must be provided by Comet`).toBe('Comet');
      expect(model.label, `${model.name}'s label must be operator-readable`).toContain('Comet');
    }
  });

  /*
   * Every rung of the model tier ladder MUST be listed, not merely priced: `stream-text.ts` looks the
   * model up in the provider's list and falls back to `modelsList[0]` behind a `logger.warn` on a miss,
   * so an unlisted rung runs one model while settlement charges for another. Asserted against the
   * constants rather than literals — a test title naming today's default goes stale the next time the
   * ladder moves, and `kie.spec.ts` records exactly that happening.
   */
  it('offers every model tier rung — Standard and Premium', () => {
    const names = COMET_MODELS.map((m) => m.name);

    expect(names).toContain(DEFAULT_MODEL);
    expect(names).toContain(DEFAULT_PREMIUM_MODEL);
  });

  /*
   * Every shipped id must be one this file's dispatch can actually place. An id whose family nothing
   * claims would be offered in the picker and then refused by `requireFamily` at the moment of use —
   * a model the operator believes is configured, failing on the first generation.
   *
   * ⚠️ This is NOT a pricing assertion. The "every offered model is priced" pin lives in
   * `app/lib/.server/billing/comet-prices.spec.ts` with the prices themselves (added by T5) — asserting
   * it here would risk passing against another provider's table, which is the mis-bill the split
   * `activeMarketPrices(provider)` exists to prevent.
   */
  it('ships only ids the family dispatch can place on a wire', () => {
    for (const model of COMET_MODELS) {
      const family = familyOf(model.name);

      expect(family, `${model.name} belongs to no family and could not be dispatched`).toBeDefined();
      expect(COMET_WIRES[family!], `${model.name}'s family has no wire binding`).toBeDefined();
    }
  });

  /*
   * The list is Claude-only ON PURPOSE (FR4): every id here was live-probed, and a row added on the
   * strength of Comet's 276-row feed is a 404 waiting to happen — its `code` and `id` fields already
   * disagree (`grok-4.5` carries `code: "grok-4-5"`), the identical drift class that shipped a 404 on
   * KIE. The other families reach the wire correctly WITHOUT being listed, via `cometEnvModel`.
   *
   * This is a decision, not a limitation, so it is pinned as one — if a `grok-*` row is added later
   * this test should be updated with the probe evidence, not deleted.
   */
  it('ships only live-probed claude ids — the other families reach the wire via config', () => {
    for (const model of COMET_MODELS) {
      expect(familyOf(model.name), `${model.name} was shipped without a probe`).toBe('claude');
    }

    // Control: the config door for an unlisted family is genuinely open.
    expect(cometEnvModel({ LLM_MODEL: 'grok-4.5' })?.provider).toBe('Comet');
  });

  /* Two rows for one model can disagree about price, so ids must be unique. */
  it('has no duplicate ids', () => {
    const names = COMET_MODELS.map((m) => m.name);

    expect(new Set(names).size).toBe(names.length);
  });
});

describe('COMET_WIRES', () => {
  /*
   * 🔴 EXHAUSTIVE OVER `FAMILY_POLICY`, not over a list written here.
   *
   * A `Record<ModelFamily, CometWire>` is a compile-time guarantee, and that guarantee is exactly what
   * a runtime test cannot see — so this asserts it over the DECLARED UNION (via `FAMILY_POLICY`'s own
   * keys) rather than over an enumeration someone typed, which is the mistake `coversWorkspace`
   * recorded: a test written against the same enumeration cannot notice what the enumeration missed.
   */
  it('binds every declared family to a wire', () => {
    for (const family of Object.keys(FAMILY_POLICY) as Array<keyof typeof FAMILY_POLICY>) {
      expect(COMET_WIRES[family], `family "${family}" has no wire binding`).toBeDefined();
    }
  });

  /*
   * `codex` and `chat` share a WIRE and not a POLICY, and that is the whole point of the split: they
   * are the same OpenAI dialect on this provider but differ in the thing a family exists to decide —
   * `codex` quotes an explicit cache pair, no vendor quotes one for `chat`. Collapsing them would price
   * a Grok row on GPT's cache economics.
   */
  it('gives codex and chat the same wire and different cache policies', () => {
    expect(COMET_WIRES.codex).toBe('chat');
    expect(COMET_WIRES.chat).toBe('chat');
    expect(FAMILY_POLICY.codex.cacheProfile).not.toBe(FAMILY_POLICY.chat.cacheProfile);
  });

  /* And claude is the only family on the Messages wire — the one surface that can carry cache_control. */
  it('routes claude, and only claude, to the Messages wire', () => {
    const onMessages = (Object.keys(COMET_WIRES) as Array<keyof typeof COMET_WIRES>).filter(
      (family) => COMET_WIRES[family] === 'messages',
    );

    expect(onMessages).toEqual(['claude']);
  });
});
