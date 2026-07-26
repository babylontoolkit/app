/**
 * Regression tests for the three wire-level Anthropic failures (SPEC §4.2a, spec/anthropic-models.md §3).
 *
 * These bugs are invisible to typecheck and to any test that asserts on our own intermediate
 * objects — they live between our code and the wire. So these tests assert on the ACTUAL
 * serialized request body, and drive the REAL `ai.streamText` pipeline against a replayed SSE
 * stream in the exact shape production sends.
 *
 * NOTE: this imports `capabilities` + the ai-sdk directly rather than `AnthropicProvider`, because
 * `base-provider → manager → registry → providers → base-provider` is an import cycle that the
 * bundler tolerates and vitest does not. Pre-existing; don't restructure it for a test.
 */
import { createAnthropic } from '@ai-sdk/anthropic';
import { streamText } from 'ai';
import { describe, expect, it } from 'vitest';
import {
  canDisableThinking,
  dropOrphanReasoningSignatures,
  parseEffort,
  stripSamplingParams,
  supportsAdaptiveThinking,
  supportsSamplingParams,
  thinkingFetch,
} from '~/lib/modules/llm/capabilities';

/** Builds an Anthropic SSE response body from raw event objects. */
function sseResponse(events: object[]): Response {
  const body = events.map((e) => `event: ${(e as any).type}\ndata: ${JSON.stringify(e)}\n\n`).join('');

  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

/**
 * The production stream shape for a model with adaptive thinking and `display: "omitted"`:
 * a thinking block whose text is EMPTY, a `signature_delta`, and NO `thinking_delta`.
 *
 * Getting this shape right is the whole test. An invented `thinking_delta` carrying text would
 * pass against a stream that does not exist in production, and the bug would ship.
 */
const EMPTY_THINKING_THEN_TEXT = [
  {
    type: 'message_start',
    message: {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-5',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 1 },
    },
  },
  { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-with-no-reasoning' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hello' } },
  { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: ' world' } },
  { type: 'content_block_stop', index: 1 },
  {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { output_tokens: 5 },
  },
  { type: 'message_stop' },
];

/** A stream where thinking DOES carry text — the legitimate reasoning + signature pair. */
const REAL_THINKING_THEN_TEXT = [
  EMPTY_THINKING_THEN_TEXT[0],
  { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Let me think.' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'legit-signature' } },
  { type: 'content_block_stop', index: 0 },
  ...EMPTY_THINKING_THEN_TEXT.slice(4),
];

/** Captures the serialized request body the provider puts on the wire. */
function capturingFetch(events: object[]) {
  const captured: { body?: any; headers?: Record<string, string> } = {};

  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    captured.body = JSON.parse(String(init?.body));
    captured.headers = init?.headers as Record<string, string>;

    return sseResponse(events);
  }) as unknown as typeof fetch;

  return { captured, fetchImpl };
}

/** Drains a streamText result to completion, returning the concatenated text. */
async function drain(result: ReturnType<typeof streamText>): Promise<string> {
  let text = '';

  for await (const chunk of result.textStream) {
    text += chunk;
  }

  return text;
}

describe('supportsSamplingParams', () => {
  it('reports the current flagships as having removed sampling params', () => {
    expect(supportsSamplingParams('claude-sonnet-5')).toBe(false);
    expect(supportsSamplingParams('claude-opus-4-8')).toBe(false);
    expect(supportsSamplingParams('claude-opus-4-7')).toBe(false);
    expect(supportsSamplingParams('claude-fable-5')).toBe(false);
  });

  it('reports older models as still accepting them', () => {
    expect(supportsSamplingParams('claude-haiku-4-5')).toBe(true);
    expect(supportsSamplingParams('claude-opus-4-6')).toBe(true);
    expect(supportsSamplingParams('claude-sonnet-4-6')).toBe(true);
  });

  it('resolves Bedrock-prefixed ids', () => {
    expect(supportsSamplingParams('anthropic.claude-sonnet-5')).toBe(false);
    expect(supportsSamplingParams('anthropic.claude-haiku-4-5')).toBe(true);
  });

  /*
   * THE POINT OF THE INVERTED LIST, and the one case the old allow-list got wrong.
   *
   * `LLM_MODEL` exists so an operator can move to a new model with an env var and a promoted price row —
   * no code change, no redeploy. Under an allow-list of MODERN ids that was impossible: a model the
   * constant had never heard of fell through to the legacy branch, `stripSamplingParams` never fired,
   * `ai@4` injected `temperature: 0`, and EVERY generation 400'd before a token.
   *
   * So the assertion is deliberately about an id that does not exist and never will: a future model must
   * default to modern handling. If someone re-inverts the list, this is the test that says why not.
   */
  it('defaults an UNKNOWN (future) model to modern handling — no sampling params', () => {
    expect(supportsSamplingParams('claude-opus-5')).toBe(false);
    expect(supportsSamplingParams('claude-opus-9')).toBe(false);
    expect(supportsSamplingParams('claude-something-entirely-new')).toBe(false);
    expect(supportsSamplingParams('anthropic.claude-opus-5')).toBe(false);
  });

  it('still reports the legacy 3.x family, dated snapshots included', () => {
    expect(supportsSamplingParams('claude-3-haiku-20240307')).toBe(true);
    expect(supportsSamplingParams('claude-3-5-sonnet-20241022')).toBe(true);
  });
});

describe('stripSamplingParams (§3.1 — `temperature is deprecated for this model`)', () => {
  /*
   * `ai@4` injects `temperature: 0` when the caller supplies none, so the unwrapped model puts a
   * sampling param on the wire even though nothing in our code ever set one. This test asserts on
   * the serialized body precisely because the call site looks innocent.
   */
  it('leaves NO sampling params in the serialized request body', async () => {
    const { captured, fetchImpl } = capturingFetch(EMPTY_THINKING_THEN_TEXT);
    const anthropic = createAnthropic({ apiKey: 'test-key', fetch: fetchImpl });

    const model = dropOrphanReasoningSignatures(stripSamplingParams(anthropic('claude-sonnet-5')));

    await drain(streamText({ model, prompt: 'hi' }));

    expect(captured.body).toBeDefined();
    expect(captured.body).not.toHaveProperty('temperature');
    expect(captured.body).not.toHaveProperty('top_p');
    expect(captured.body).not.toHaveProperty('top_k');
  });

  it('proves the bug exists without the wrapper: ai@4 injects temperature: 0 unasked', async () => {
    const { captured, fetchImpl } = capturingFetch(EMPTY_THINKING_THEN_TEXT);
    const anthropic = createAnthropic({ apiKey: 'test-key', fetch: fetchImpl });

    // Same call, but only the reasoning wrapper — no sampling strip.
    const model = dropOrphanReasoningSignatures(anthropic('claude-sonnet-5'));

    await drain(streamText({ model, prompt: 'hi' }));

    // This `0` is what the API 400s on. Nobody in our code asked for it.
    expect(captured.body.temperature).toBe(0);
  });

  it('does not touch models that still accept sampling params', async () => {
    const { captured, fetchImpl } = capturingFetch(EMPTY_THINKING_THEN_TEXT);
    const anthropic = createAnthropic({ apiKey: 'test-key', fetch: fetchImpl });

    const raw = anthropic('claude-haiku-4-5');
    const model = dropOrphanReasoningSignatures(
      supportsSamplingParams('claude-haiku-4-5') ? raw : stripSamplingParams(raw),
    );

    await drain(streamText({ model, prompt: 'hi', temperature: 0.7 }));

    expect(captured.body.temperature).toBe(0.7);
  });
});

describe('dropOrphanReasoningSignatures (§3.3 — `reasoning-signature without reasoning`)', () => {
  it('streams text through an empty thinking block + signature_delta', async () => {
    const { fetchImpl } = capturingFetch(EMPTY_THINKING_THEN_TEXT);
    const anthropic = createAnthropic({ apiKey: 'test-key', fetch: fetchImpl });

    const model = dropOrphanReasoningSignatures(stripSamplingParams(anthropic('claude-sonnet-5')));

    await expect(drain(streamText({ model, prompt: 'hi' }))).resolves.toBe('Hello world');
  });

  it('proves the bug exists without the wrapper: the orphan signature blows up ai@4', async () => {
    const { fetchImpl } = capturingFetch(EMPTY_THINKING_THEN_TEXT);
    const anthropic = createAnthropic({ apiKey: 'test-key', fetch: fetchImpl });

    // Bypass the wrapper — the exact production failure.
    const model = stripSamplingParams(anthropic('claude-sonnet-5'));

    await expect(drain(streamText({ model, prompt: 'hi' }))).rejects.toThrow(/reasoning-signature|InvalidStreamPart/i);
  });

  it('passes REAL reasoning and its legitimate signature through untouched', async () => {
    const { fetchImpl } = capturingFetch(REAL_THINKING_THEN_TEXT);
    const anthropic = createAnthropic({ apiKey: 'test-key', fetch: fetchImpl });

    const model = dropOrphanReasoningSignatures(stripSamplingParams(anthropic('claude-sonnet-5')));
    const result = streamText({ model, prompt: 'hi' });

    await expect(drain(result)).resolves.toBe('Hello world');
    await expect(result.reasoning).resolves.toBe('Let me think.');
  });
});

/**
 * §3.4 — `thinking` is an explicit decision, and the SDK cannot make it.
 *
 * This is a LATENCY and MONEY path, and its failure mode is a silent default. Omitting `thinking` on
 * a current Claude model does not mean "off" — it means adaptive thinking ON with `display:
 * "omitted"`: reasoning billed at the full output rate that the API never sends us and we cannot show
 * anyone. Measured on one project creation, same prompt, same files:
 *
 *              time-to-first-byte   wall clock   output tokens   cost
 *   adaptive         90.5s             152s         16,619       $0.293
 *   disabled          1.6s              72s         10,403       $0.200
 *
 * Ninety seconds of dead air — no text, not even response headers — is what the user reported as the
 * app "just sitting there with no status".
 *
 * And `providerOptions` cannot express any of this: `@ai-sdk/anthropic@1.2.12` predates adaptive
 * thinking and hardcodes the LEGACY `{type: 'enabled', budget_tokens: N}` shape, which current models
 * reject with a 400. The request body is assembled inside the provider, so `fetch` is the only seam
 * that reaches it. These tests assert on the bytes actually sent.
 */
describe('thinkingFetch (§3.4 — the silent default that costs 90s and 6,000 output tokens)', () => {
  it('sends `thinking: {type: "disabled"}` — the shipping default', async () => {
    const { captured, fetchImpl } = capturingFetch(EMPTY_THINKING_THEN_TEXT);
    const anthropic = createAnthropic({
      apiKey: 'test-key',
      fetch: thinkingFetch('disabled', 'medium', 'claude-sonnet-5', fetchImpl),
    });

    const model = dropOrphanReasoningSignatures(stripSamplingParams(anthropic('claude-sonnet-5')));
    await drain(streamText({ model, prompt: 'hi' }));

    expect(captured.body.thinking).toEqual({ type: 'disabled' });
  });

  /**
   * `display: 'summarized'` is the whole point. The default (`omitted`) bills us for reasoning and
   * returns an EMPTY thinking block — we pay for the tokens and have nothing to show, which is what
   * turned a 90-second think into a dead spinner. Summarized costs nothing extra.
   */
  it('sends `{type: "adaptive", display: "summarized"}` — NOT the legacy budget_tokens shape, which 400s', async () => {
    const { captured, fetchImpl } = capturingFetch(EMPTY_THINKING_THEN_TEXT);
    const anthropic = createAnthropic({
      apiKey: 'test-key',
      fetch: thinkingFetch('adaptive', 'medium', 'claude-sonnet-5', fetchImpl),
    });

    const model = dropOrphanReasoningSignatures(stripSamplingParams(anthropic('claude-sonnet-5')));
    await drain(streamText({ model, prompt: 'hi' }));

    expect(captured.body.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
    expect(captured.body.thinking).not.toHaveProperty('budget_tokens');
  });

  /**
   * Proves the omission is not neutral. Without the wrapper there is no `thinking` field at all —
   * which reads like "off" and is in fact adaptive-on. That is the whole bug.
   */
  it('proves the default is silent: with no wrapper, the body carries NO thinking field', async () => {
    const { captured, fetchImpl } = capturingFetch(EMPTY_THINKING_THEN_TEXT);
    const anthropic = createAnthropic({ apiKey: 'test-key', fetch: fetchImpl });

    const model = dropOrphanReasoningSignatures(stripSamplingParams(anthropic('claude-sonnet-5')));
    await drain(streamText({ model, prompt: 'hi' }));

    expect(captured.body).not.toHaveProperty('thinking');
  });

  /** Fable 5 thinks unconditionally — an explicit `disabled` is a 400. Never send it one. */
  it('never disables thinking on a model that forbids disabling it', () => {
    expect(canDisableThinking('claude-fable-5')).toBe(false);
    expect(canDisableThinking('claude-sonnet-5')).toBe(true);
  });

  /** Older models take neither shape — leave their bodies alone entirely. */
  it('leaves a model without adaptive thinking untouched', () => {
    expect(supportsAdaptiveThinking('claude-sonnet-5')).toBe(true);
    expect(supportsAdaptiveThinking('anthropic.claude-opus-4-8')).toBe(true);
    expect(supportsAdaptiveThinking('claude-3-haiku-20240307')).toBe(false);
  });

  /*
   * The silent half of the inverted-list bug (see `supportsSamplingParams` above for the loud half).
   *
   * As an allow-list of MODERN ids, an unknown model made `thinkingFetch` early-return — so the request
   * carried neither `display: 'summarized'` nor `output_config.effort`, silently buying the server-default
   * `high` effort and returning EMPTY thinking text. Nothing throws and the token count goes DOWN, which
   * reads like a cheaper turn. A future model must default to modern.
   */
  it('defaults an UNKNOWN (future) model to adaptive thinking', () => {
    expect(supportsAdaptiveThinking('claude-opus-5')).toBe(true);
    expect(supportsAdaptiveThinking('claude-opus-9')).toBe(true);
    expect(supportsAdaptiveThinking('anthropic.claude-opus-5')).toBe(true);
  });

  /*
   * §Opus 5 — `disabled` is gated by EFFORT, not merely by model.
   *
   * `{type:'disabled'}` is accepted at `high` and below, and a 400 at `xhigh`/`max`. This is reachable
   * from an env file alone and at the worst moment: `effort-policy.ts` escalates a 2nd repair to `xhigh`,
   * so a `THINKING_MODE=disabled` operator would 400 on the turn that had already failed twice.
   */
  it('honours the per-model effort ceiling for disabling thinking', () => {
    expect(canDisableThinking('claude-opus-5', 'medium')).toBe(true);
    expect(canDisableThinking('claude-opus-5', 'high')).toBe(true);
    expect(canDisableThinking('claude-opus-5', 'xhigh')).toBe(false);
    expect(canDisableThinking('claude-opus-5', 'max')).toBe(false);
  });

  it('applies no effort ceiling to models that do not have one', () => {
    for (const effort of ['medium', 'high', 'xhigh', 'max'] as const) {
      expect(canDisableThinking('claude-opus-4-8', effort)).toBe(true);
      expect(canDisableThinking('claude-fable-5', effort)).toBe(false);
    }
  });

  /*
   * The clamp, at the wire. A preference that cannot be honoured on this turn must not burn the turn:
   * `thinkingFetch` falls back to `adaptive` rather than sending a body the API will reject.
   */
  it('CLAMPS to adaptive rather than emitting a body the API would 400', async () => {
    const { captured, fetchImpl } = capturingFetch(EMPTY_THINKING_THEN_TEXT);
    const anthropic = createAnthropic({
      apiKey: 'test-key',
      fetch: thinkingFetch('disabled', 'xhigh', 'claude-opus-5', fetchImpl),
    });

    const model = dropOrphanReasoningSignatures(stripSamplingParams(anthropic('claude-opus-5')));
    await drain(streamText({ model, prompt: 'hi' }));

    expect(captured.body.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
    expect(captured.body.output_config).toEqual({ effort: 'xhigh' });
  });
});

/**
 * §3.5 — `effort` is the dial that bounds what thinking COSTS, and it must be set explicitly.
 *
 * Thinking tokens are billed as OUTPUT tokens, at the full output rate. `output_config.effort`
 * defaults to `high` SERVER-SIDE, so a request that never mentions effort is not neutral — it is
 * silently buying the second-most-expensive setting. That is how one project creation came to spend
 * ~15,000 thinking tokens to emit ~5,500 tokens of landing page.
 *
 * Swept on an identical creation (same prompt, same files):
 *
 *   effort=high     103s   12,567 out   $0.232   78 credits   <- the accidental default
 *   effort=medium    80s   10,433 out   $0.200   67 credits   <- now the default, and the FLOOR
 *   effort=low       58s    7,461 out   $0.156   52 credits   <- REMOVED, see below
 *
 * All three produced a full-size landing page on a CREATION turn, which is what made `low` look like a
 * free win. It was not: on an EDIT turn `low` breached a read-only project zone (§4.4c), so it is no
 * longer in `EffortLevel` at all. The sweep is kept here because it is the evidence for that call.
 */
describe('effort (§3.5 — the default nobody chose)', () => {
  it('sets output_config.effort on the wire', async () => {
    const { captured, fetchImpl } = capturingFetch(EMPTY_THINKING_THEN_TEXT);
    const anthropic = createAnthropic({
      apiKey: 'test-key',
      fetch: thinkingFetch('adaptive', 'medium', 'claude-sonnet-5', fetchImpl),
    });

    const model = dropOrphanReasoningSignatures(stripSamplingParams(anthropic('claude-sonnet-5')));
    await drain(streamText({ model, prompt: 'hi' }));

    expect(captured.body.output_config).toEqual({ effort: 'medium' });
  });

  /*
   * END-TO-END PROOF THAT `LLM_MODEL=<a model this code has never heard of>` WORKS.
   *
   * This is the whole deliverable: setting an env var and promoting a price row must be enough to move
   * the platform to a new model — no code change, no redeploy. `claude-opus-5` is used as the concrete
   * near-term case, but the assertion is really about ANY unrecognised id, so it is repeated against a
   * fabricated one that will never exist.
   *
   * Under the old MODERN-allow-lists both failed: no `temperature` strip (a hard 400 on every request)
   * and no thinking/effort config (silently buying server-default `high` and empty reasoning text).
   */
  it('gives an UNKNOWN model the full modern treatment on the wire', async () => {
    for (const modelId of ['claude-opus-5', 'claude-opus-9']) {
      const { captured, fetchImpl } = capturingFetch(EMPTY_THINKING_THEN_TEXT);
      const anthropic = createAnthropic({
        apiKey: 'test-key',
        fetch: thinkingFetch('adaptive', 'medium', modelId, fetchImpl),
      });

      /*
       * ⚠️ This MUST mirror `getModelInstance`'s gate verbatim (`anthropic.ts` / `kie.ts`) — applying
       * `stripSamplingParams` unconditionally would test the wrapper (already covered above) instead of
       * the DECISION to apply it, and would pass even with the predicate inverted. Mutation-verified.
       */
      const base = anthropic(modelId);
      const model = dropOrphanReasoningSignatures(supportsSamplingParams(modelId) ? base : stripSamplingParams(base));
      await drain(streamText({ model, prompt: 'hi' }));

      // The 400 that used to happen before a single token was emitted.
      expect(captured.body).not.toHaveProperty('temperature');
      expect(captured.body).not.toHaveProperty('top_p');
      expect(captured.body).not.toHaveProperty('top_k');

      // The silent overspend: server-default effort + reasoning we pay for and cannot show.
      expect(captured.body.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
      expect(captured.body.output_config).toEqual({ effort: 'medium' });
    }
  });

  /**
   * The bug this guards: omitting `effort` is not "no opinion", it is `high`. A body with no
   * `output_config` is a body that quietly opted into the expensive setting.
   */
  it('proves the default is silent: with no wrapper, the body carries NO output_config', async () => {
    const { captured, fetchImpl } = capturingFetch(EMPTY_THINKING_THEN_TEXT);
    const anthropic = createAnthropic({ apiKey: 'test-key', fetch: fetchImpl });

    const model = dropOrphanReasoningSignatures(stripSamplingParams(anthropic('claude-sonnet-5')));
    await drain(streamText({ model, prompt: 'hi' }));

    expect(captured.body).not.toHaveProperty('output_config');
  });

  /** Effort still applies with thinking off — it governs total token spend, not just thinking depth. */
  it('sets effort even when thinking is disabled', async () => {
    const { captured, fetchImpl } = capturingFetch(EMPTY_THINKING_THEN_TEXT);
    const anthropic = createAnthropic({
      apiKey: 'test-key',
      fetch: thinkingFetch('disabled', 'xhigh', 'claude-sonnet-5', fetchImpl),
    });

    const model = dropOrphanReasoningSignatures(stripSamplingParams(anthropic('claude-sonnet-5')));
    await drain(streamText({ model, prompt: 'hi' }));

    expect(captured.body.thinking).toEqual({ type: 'disabled' });
    expect(captured.body.output_config).toEqual({ effort: 'xhigh' });
  });

  /**
   * `low` is gone from `EffortLevel` — the type system now refuses it — but `.env.local` is a string
   * file, so `parseEffort` is the wall that keeps an operator's `THINKING_EFFORT=low` off the wire.
   *
   * The measurement that earned it this treatment: on a real substantial edit, `low` edited
   * `src/routing/router.tsx` (READ-ONLY SHELL, §4.4c) and rewrote whole files instead of patching.
   * It was 58 credits cheaper and WRONG. There is no cheap tier.
   */
  describe('parseEffort — the `low` wall', () => {
    it('clamps a `low` operator config up to the default', () => {
      expect(parseEffort('low')).toBe('medium');
      expect(parseEffort('LOW')).toBe('medium');
      expect(parseEffort(' low ')).toBe('medium');
    });

    it('passes the supported levels through', () => {
      expect(parseEffort('medium')).toBe('medium');
      expect(parseEffort('high')).toBe('high');
      expect(parseEffort('xhigh')).toBe('xhigh');
      expect(parseEffort('max')).toBe('max');
    });

    it('returns undefined for nothing-to-say, so the caller keeps its own default', () => {
      expect(parseEffort(undefined)).toBeUndefined();
      expect(parseEffort('')).toBeUndefined();
      expect(parseEffort('   ')).toBeUndefined();
    });

    it('rejects a typo instead of putting it on the wire (a 400 mid-generation)', () => {
      expect(parseEffort('hgih')).toBeUndefined();
      expect(parseEffort('extra-high')).toBeUndefined();
    });
  });
});
