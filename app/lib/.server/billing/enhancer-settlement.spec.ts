/**
 * The prompt enhancer's terminal states (`spec/fail-loud.md`, SPEC §4.6).
 *
 * The enhancer is a paid, KIE-reaching call site with far less machinery around it than a generation,
 * which is exactly why it drifted: it settled every outcome as a success. A stream that errored
 * halfway, or one that finished cheerfully with no text, was logged and CHARGED — the browser got a
 * truncated response, the ledger got a debit, and nothing anywhere said a thing.
 *
 * ⚠️ This spec lives in `billing/`, NOT in `app/routes/` — Remix compiles a spec file there as a route
 * and its manifest imports `vitest` at runtime, which 500s every request.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FsLedger, setLedger } from './ledger';
import { setGenerationStore, type GenerationStore, type GenerationUpsert } from './generations';
import { MODEL_RATES } from './rates';
import { setEnhancerStepsWaitForTests } from './enhancer-usage';
import { streamText as realStreamText } from 'ai';
import { MockLanguageModelV1 } from 'ai/test';
import type { WireUsageRecorder } from '~/lib/modules/llm/wire-usage';

const USER = 'user-enh';

const streamText = vi.fn();

vi.mock('~/lib/.server/llm/stream-text', () => ({ streamText: (...args: unknown[]) => streamText(...args) }));
vi.mock('~/lib/.server/supabase/auth', () => ({
  requireVerifiedUser: async () => ({ id: USER, email: 'e@example.com', isLocal: false }),
}));
vi.mock('~/lib/.server/licensing/entitlements', () => ({ resolveByok: async () => ({ allowed: false }) }));

/*
 * The route's model comes from `getEnhancerModel` (`ENHANCE_PROMPT_MODEL`), not `getPlatformModel` —
 * hoisted so a case can change it and watch what reaches the wire and the ledger.
 *
 * 🔴 `seenOverride` records the provider the route handed the model lookup. The route resolves the
 * gateway ONCE and threads that value to the model lookup, the wire and `settleGeneration` alike; a
 * function that re-derives it instead is the `kieEnvModel` two-readers defect, and with
 * `AUTO_MODEL_SELECT` on the two readers really can disagree.
 */
const config = vi.hoisted(() => ({
  model: 'claude-opus-4-8',
  provider: 'KIE',
  seenOverride: undefined as string | undefined,
}));

vi.mock('~/lib/.server/agent/config', () => ({
  getEnhancerModel: (_context: unknown, providerOverride?: string) => {
    config.seenOverride = providerOverride;
    return config.model;
  },

  resolvePlatformProvider: () => config.provider,

  /*
   * 🔴 DELIBERATELY EXPLOSIVE. This is what the route used to call, and the whole point of the
   * 2026-08-11 change is that it no longer does: `getPlatformProvider` reads `LLM_PROVIDER` and is
   * blind to the ladder, so a turn could be served by one gateway and have its model validated against
   * another's price table. Exporting it as a throw makes a revert a test failure rather than a silent
   * behaviour change — a mock that quietly answers both spellings cannot tell them apart.
   */
  getPlatformProvider: () => {
    throw new Error('the enhancer must resolve the LADDER-selected gateway, not LLM_PROVIDER');
  },
}));

let tmp: string;
let ledger: FsLedger;
let upserts: GenerationUpsert[];

/** The settlement's writes — the D2 `running` row opened before the model call is not one of them. */
const finals = () => upserts.filter((u) => u.status !== 'running');

/** One ai@4 `StepResult`, cut down to the fields `accumulateStepUsage` reads. */
interface FakeStep {
  usage: { promptTokens?: number; completionTokens?: number };
  providerMetadata?: unknown;
}

/**
 * A fake `streamText` result: the parts the route consumes, and nothing else.
 *
 * `steps` is OPTIONAL, and its absence is a real production shape rather than a convenience — the
 * route falls back to `result.usage` when there are none, and settlement can never refuse (§4.6).
 */
function fakeResult(parts: unknown[], steps?: FakeStep[]) {
  return {
    ...(steps ? { steps: Promise.resolve(steps) } : {}),
    fullStream: (async function* () {
      for (const part of parts) {
        yield part;
      }
    })(),
    textStream: (async function* () {
      for (const part of parts as Array<{ type: string; textDelta?: string }>) {
        if (part.type === 'text-delta' && part.textDelta) {
          yield part.textDelta;
        }
      }
    })(),
    usage: Promise.resolve({ promptTokens: 4000, completionTokens: 1200 }),
  };
}

async function enhance() {
  const { action } = await import('~/routes/api.enhancer');

  return action({
    request: new Request('http://localhost/api/enhancer', {
      method: 'POST',
      body: JSON.stringify({ message: 'make a racing game' }),
    }),
    context: {},
    params: {},
  } as never);
}

beforeEach(async () => {
  /*
   * The oauth.spec trap: `env()` falls back to `process.env`, and vitest loads `.env.local`.
   *
   * `CREATION_FLAT_CREDITS` is RETIRED (§4.4a) and `getBillingConfig` throws when it is set, so it
   * belongs in this list for a stronger reason than the price vars beside it: leaving it out does not
   * skew an assertion, it kills the settlement path outright on the operator's machine only.
   */
  for (const key of ['BILLING_ENFORCED', 'CREDIT_UNIT_COST_USD', 'CREDIT_MARGIN', 'CREATION_FLAT_CREDITS']) {
    vi.stubEnv(key, undefined as unknown as string);
  }

  vi.stubEnv('BILLING_ENFORCED', 'true');

  config.model = 'claude-opus-4-8';
  config.provider = 'KIE';
  config.seenOverride = undefined;

  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'enh-'));
  ledger = new FsLedger(tmp);
  setLedger(ledger);
  await ledger.append({ userId: USER, delta: 1000, reason: 'grant' });

  upserts = [];
  setGenerationStore({
    upsert: async (row: GenerationUpsert) => void upserts.push(row),
    markStatus: async () => true,
    list: async () => [],
  } as unknown as GenerationStore);
});

afterEach(async () => {
  setEnhancerStepsWaitForTests(undefined);
  setLedger(undefined);
  setGenerationStore(undefined);
  streamText.mockReset();
  await fs.rm(tmp, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe('the enhancer settles into exactly one terminal state', () => {
  it('DELIVERED — text streamed, so the charge stands', async () => {
    streamText.mockResolvedValue(fakeResult([{ type: 'text-delta', textDelta: 'a better prompt' }]));

    await enhance();

    await vi.waitFor(() => expect(finals().length).toBeGreaterThan(0));
    expect(await ledger.balance(USER)).toBeLessThan(1000);
    expect(upserts.every((u) => u.status !== 'failed')).toBe(true);
  });

  it('REFUNDED — a stream error mid-enhancement comes back, and records `failed`', async () => {
    streamText.mockResolvedValue(
      fakeResult([
        { type: 'text-delta', textDelta: 'a bett' },
        { type: 'error', error: new Error('provider exploded') },
      ]),
    );

    await enhance();

    await vi.waitFor(() => expect(upserts.some((u) => u.status === 'failed')).toBe(true));
    expect(await ledger.balance(USER), 'the debit came straight back').toBe(1000);
  });

  /*
   * The proxy's `producedText` rule, one subsystem over: a clean finish with nothing to show is a
   * failure however cheerfully the provider says `stop`. The user pasted a prompt and got an empty
   * textarea back — charging for that is the 316-credit promise in miniature.
   */
  it('REFUNDED — a zero-text finish is a failure, not a cheap success', async () => {
    streamText.mockResolvedValue(fakeResult([{ type: 'step-finish' }]));

    await enhance();

    await vi.waitFor(() => expect(upserts.some((u) => u.status === 'failed')).toBe(true));
    expect(await ledger.balance(USER)).toBe(1000);
  });

  /*
   * no-unbilled-usage D2: the row exists, `running`, BEFORE the provider call — so an enhancement whose
   * process dies (or whose stream hangs) leaves a record the sweep can settle.
   */
  it('opens a running row before the model is called, and settlement finishes the same id', async () => {
    let statusesAtCall: Array<string | undefined> = [];

    streamText.mockImplementation(async () => {
      statusesAtCall = upserts.map((u) => u.status);
      return fakeResult([{ type: 'text-delta', textDelta: 'a better prompt' }]);
    });

    await enhance();
    await vi.waitFor(() => expect(finals().length).toBeGreaterThan(0));

    expect(statusesAtCall).toEqual(['running']);
    expect(upserts[0]).toMatchObject({ engine: 'enhancer', statusKind: 'enhance' });
    expect(new Set(upserts.map((u) => u.id)).size, 'one generation id, never a second row').toBe(1);
  });

  it('REFUSED BEFORE SPEND — an empty balance never reaches the model', async () => {
    await ledger.append({ userId: USER, delta: -1000, reason: 'adjustment' });
    streamText.mockResolvedValue(fakeResult([{ type: 'text-delta', textDelta: 'x' }]));

    const response = (await enhance()) as Response;

    expect(response.status).toBe(402);
    expect(streamText, 'the gate refused before the model was called').not.toHaveBeenCalled();
  });
});

/**
 * 🔴 THE ENHANCER BILLS FROM THE STEPS — `result.usage` was reporting ZERO INPUT (live, 2026-08-11).
 *
 * A real enhancement settled `promptTokens: 0` against 335 output tokens: the ~600-token system prompt
 * and the user's own text were never billed at all. An UNDER-charge, which is `rates.ts`' safe
 * direction and precisely why it could sit here indefinitely with nothing failing — no error, no
 * refusal, just a number quietly missing from a money path. Live before/after: `promptTokens 0 → 295`.
 *
 * ⚠️ Every case here makes `result.usage` DISAGREE with the steps, deliberately. A fixture where the
 * two agree passes for the reverted implementation, i.e. is no test at all.
 */
describe('🔴 the enhancer bills from result.steps, not result.usage', () => {
  async function settleWithSteps(steps: FakeStep[]) {
    streamText.mockResolvedValue(fakeResult([{ type: 'text-delta', textDelta: 'a better prompt' }], steps));

    await enhance();
    await vi.waitFor(() => expect(finals().length).toBeGreaterThan(0));

    return finals().at(-1)!;
  }

  /*
   * The live shape, exactly: 295 in / 335 out on the step, while `result.usage` (the 4000/1200 the
   * fixture reports) is the surface that was being read. Only a steps-based read can produce 295.
   */
  it('settles the STEP input tokens — the number that was silently zero', async () => {
    const row = await settleWithSteps([{ usage: { promptTokens: 295, completionTokens: 335 } }]);

    expect(row.promptTokens, 'the system prompt and the user text were billed as nothing').toBe(295);
    expect(row.completionTokens).toBe(335);
    expect(row.promptTokens, 'and it is genuinely the step, not result.usage').not.toBe(4000);
  });

  it('charges for that input rather than treating the prompt as free', async () => {
    const row = await settleWithSteps([{ usage: { promptTokens: 295, completionTokens: 335 } }]);

    expect(row.creditsCharged).toBeGreaterThan(0);
    expect(row.totalTokens).toBe(630);
  });

  /*
   * `accumulateStepUsage` is the function settlement already trusts for every generation, and summing
   * is the property a hand-rolled read loses first. The enhancer is single-step today; the reason to
   * pin this is that "today" is what the old code encoded.
   */
  it('sums across steps rather than reading the last one', async () => {
    const row = await settleWithSteps([
      { usage: { promptTokens: 295, completionTokens: 335 } },
      { usage: { promptTokens: 100, completionTokens: 20 } },
    ]);

    expect(row.promptTokens).toBe(395);
    expect(row.completionTokens).toBe(355);
  });

  /*
   * THE FALLBACK, and it is required rather than tolerated: settlement can never refuse (§4.6), so a
   * result shape with no steps must still bill SOMETHING instead of throwing the turn away. This is
   * also the branch every OTHER case in this file runs through, which is why it needs stating.
   */
  it('falls back to result.usage when there are no steps at all', async () => {
    streamText.mockResolvedValue(fakeResult([{ type: 'text-delta', textDelta: 'a better prompt' }]));

    await enhance();
    await vi.waitFor(() => expect(finals().length).toBeGreaterThan(0));

    expect(finals().at(-1)).toMatchObject({ promptTokens: 4000, completionTokens: 1200 });
  });

  it('falls back to result.usage when the steps array is EMPTY, not just absent', async () => {
    streamText.mockResolvedValue(fakeResult([{ type: 'text-delta', textDelta: 'a better prompt' }], []));

    await enhance();
    await vi.waitFor(() => expect(finals().length).toBeGreaterThan(0));

    expect(finals().at(-1)?.promptTokens, 'an empty array must not bill zero').toBe(4000);
  });

  /*
   * 🔴 THE FAMILY IS THREADED, AND WITHOUT IT THE CACHED TOKENS ARE BILLED TWICE.
   *
   * `accumulateStepUsage`'s `family` argument is OPTIONAL and an omitted one falls back to the
   * `anthropic` namespace with `promptTokensIncludeCacheRead: false` — byte-identical to what the
   * function did before families existed, and silently wrong for every other wire. On the codex family
   * `cached_tokens` is a BREAKDOWN of `prompt_tokens`, so an un-subtracted cache read is charged once
   * at the full input rate and again at the cache rate: measured live at **1.86x** on a real
   * `gpt-5-6-terra` turn (T12).
   *
   * The enhancer is a `<PROVIDER>_ENHANCE_PROMPT_MODEL` away from a non-Claude model at any time, and
   * every OTHER case in this file uses a Claude id — for which the correct and the defaulted answers
   * are the SAME. Dropping `familyOf(model)` would pass all of them.
   */
  it('subtracts the cached tokens on a family whose prompt total includes them', async () => {
    config.model = 'gpt-5-6-terra';
    config.provider = 'KIE';

    const row = await settleWithSteps([
      {
        usage: { promptTokens: 20_000, completionTokens: 100 },
        providerMetadata: { openai: { cachedPromptTokens: 17_742 } },
      },
    ]);

    expect(row.cacheReadTokens).toBe(17_742);
    expect(row.promptTokens, 'the cached portion must not also be billed at the full input rate').toBe(2_258);
  });

  /*
   * CONTROL. The identical step shape on a CLAUDE model, whose wire reports the two as siblings — so
   * here the prompt total is left alone. Without this, the case above passes for an implementation
   * that subtracts unconditionally, which is the same double-count pointing the other way.
   */
  it('CONTROL: leaves the prompt total alone on a family that reports them separately', async () => {
    config.model = 'claude-haiku-4-5';
    config.provider = 'Anthropic';

    const row = await settleWithSteps([
      {
        usage: { promptTokens: 20_000, completionTokens: 100 },
        providerMetadata: { anthropic: { cacheReadInputTokens: 17_742 } },
      },
    ]);

    expect(row.cacheReadTokens).toBe(17_742);
    expect(row.promptTokens).toBe(20_000);
  });

  /*
   * 🔴 AND THE ROW SAYS WHICH GATEWAY SPENT IT.
   *
   * Settlement is the enhancer's ONLY write — there is no enrichment step behind it — so before
   * `gate.ts` put `provider` in the anchor payload, every enhancement row had no provider at all and
   * the §4.10 per-provider view silently excluded the lot. Asserted here, on the caller that has
   * nothing downstream to fix a gap up, and with a non-default gateway so a constant cannot pass.
   */
  it('records the gateway the enhancement was priced against', async () => {
    config.provider = 'Comet';

    const row = await settleWithSteps([{ usage: { promptTokens: 295, completionTokens: 335 } }]);

    expect(row.provider).toBe('Comet');
  });
});

/**
 * `ENHANCE_PROMPT_MODEL` reaches BOTH the wire and the ledger (§4.2a).
 *
 * The saving is only real if the cheap model is the one that actually RUNS, and the bill is only
 * honest if it is the one that is PRICED — and those travel by different roads. The model reaches the
 * provider inside a `[Model: …]` prefix on the message (upstream's `streamText` parses it), while the
 * price comes from the `model` handed to `settleGeneration`. Assert one and the other can drift: a
 * route that ran Haiku and settled at Sonnet's rates would triple the bill it was set up to cut, and
 * one that settled at Haiku's rates while running Sonnet would under-charge us. Both are silent.
 */
describe('the enhancer model is the one that runs AND the one that is billed', () => {
  async function enhanceWith(model: string) {
    config.model = model;
    config.provider = 'Anthropic';
    streamText.mockResolvedValue(fakeResult([{ type: 'text-delta', textDelta: 'a better prompt' }]));

    await enhance();
    await vi.waitFor(() => expect(finals().length).toBeGreaterThan(0));

    return { billedModel: finals().at(-1)?.model, spent: 1000 - (await ledger.balance(USER)) };
  }

  it('sends the configured model to the provider', async () => {
    await enhanceWith('claude-haiku-4-5');

    const content = streamText.mock.calls[0][0].messages[0].content as string;

    expect(content).toContain('[Model: claude-haiku-4-5]');
    expect(content, 'the platform model must not leak in beside it').not.toContain('claude-sonnet-5');
  });

  it('settles against the configured model, not the platform one', async () => {
    const { billedModel } = await enhanceWith('claude-haiku-4-5');

    expect(billedModel).toBe('claude-haiku-4-5');
  });

  /*
   * 🔴 ONE RESOLUTION, THREADED — the property the per-gateway enhancer keys rest on.
   *
   * Haiku 4.5 is `claude-haiku-4-5` on KIE and Anthropic and only `claude-haiku-4-5-20251001` on Comet,
   * so "which model?" cannot be answered without "which gateway?". If the route resolved the gateway
   * once for the wire and let `getEnhancerModel` re-derive its own, the two could name different
   * gateways on the same request — the model validated against one price table, the tokens spent on
   * another. The route passing its resolved provider down is what makes that impossible.
   */
  it('hands the model lookup the gateway it resolved, rather than letting it re-derive one', async () => {
    await enhanceWith('claude-haiku-4-5');
    expect(config.seenOverride, 'the resolved provider must reach getEnhancerModel').toBe('Anthropic');

    config.provider = 'Comet';
    upserts.length = 0;
    streamText.mockResolvedValue(fakeResult([{ type: 'text-delta', textDelta: 'a better prompt' }]));

    await enhance();
    await vi.waitFor(() => expect(finals().length).toBeGreaterThan(0));

    expect(config.seenOverride, 'and it follows the resolution, it is not a constant').toBe('Comet');
  });

  /*
   * The point of the whole change, in one number: a cheap enhancer model costs strictly less than the
   * platform model on an identical usage shape, in the exact proportion of their rates.
   *
   * ⚠️ **This comment used to CLAIM the ratio was derived and the code hardcoded `* 3`** — "Deriving the
   * ratio from the rates rather than pinning two literals means a repriced row moves the expectation with
   * it instead of failing a test that was never about those two numbers." It was pinning two literals, so
   * when Sonnet 5 moved to its true $2/$10 (2026-08-12) the ratio became 2 and this failed exactly as the
   * comment promised it would not. A comment describing a property the code does not have is how a defect
   * survives review — the recurring lesson in this repo, here costing a red test rather than money.
   *
   * It derives now. The uniformity CONTROL is load-bearing: a single ratio is only meaningful while the
   * two rows are proportional across every token class, and if a reprice ever breaks that, this test must
   * fail loudly rather than silently compare one class's ratio against another's cost.
   */
  it('costs strictly less than the platform model on identical usage', async () => {
    const [cheapRates, dearRates] = [MODEL_RATES['claude-haiku-4-5'], MODEL_RATES['claude-sonnet-5']];
    const ratio = dearRates.inputPerMTok / cheapRates.inputPerMTok;

    for (const cls of ['inputPerMTok', 'outputPerMTok', 'cacheReadPerMTok', 'cacheWritePerMTok'] as const) {
      expect(dearRates[cls] / cheapRates[cls], `${cls} must share the one ratio`).toBeCloseTo(ratio, 9);
    }

    const cheap = await enhanceWith('claude-haiku-4-5');

    await ledger.append({ userId: USER, delta: cheap.spent, reason: 'adjustment' });
    upserts.length = 0;

    const dear = await enhanceWith('claude-sonnet-5');

    expect(cheap.spent).toBeGreaterThan(0);
    expect(cheap.spent).toBeLessThan(dear.spent);
    expect(cheap.spent * ratio).toBe(dear.spent);
  });
});

/**
 * 🔴 no-unbilled-usage D8 — the enhancer CANNOT HANG on a provider that fails before streaming.
 *
 * ai@4.3.16, reproduced here against the REAL `streamText` (only the model is a mock): a `doStream` that
 * throws yields one `error` part and ends, and `result.steps` / `result.usage` never settle. The route used
 * to `await result.steps` after the drain — its settlement parked forever, the row stayed `running`, nothing
 * refunded, nothing alerted. These cases drive that exact SDK behaviour, so a revert to a bare await is a
 * timeout here, not a pass.
 */
describe('🔴 a provider error before streaming settles instead of hanging (D8)', () => {
  /** Route the mocked `streamText` through the real SDK with a model whose stream call fails. */
  function failingProvider(onCall?: (wire: WireUsageRecorder | undefined) => void) {
    streamText.mockImplementation(async (props: { wireUsage?: WireUsageRecorder }) => {
      const model = new MockLanguageModelV1({
        doStream: async () => {
          onCall?.(props.wireUsage);
          throw new Error('401 invalid x-api-key');
        },
      });

      return realStreamText({ model, prompt: 'enhance this', onError: () => undefined });
    });
  }

  it('settles, records `failed`, and the row never stays running', async () => {
    setEnhancerStepsWaitForTests(20);
    failingProvider();

    await enhance();

    await vi.waitFor(() => expect(finals().length).toBeGreaterThan(0), { timeout: 1500 });
    expect(finals().at(-1)?.status).toBe('failed');
    expect(await ledger.balance(USER), 'nothing owed, nothing kept').toBe(1000);
  });

  /*
   * The broken attempt the SDK never reported: the provider accepted the request (`message_start`) and
   * billed its input before the stream broke. The wire recorder is the only place that number exists — it
   * reaches the row's usage (the platform's absorbed cost is visible) and is refunded under the unchanged
   * failed-generation rule (D10).
   */
  it('bills the consumed input from the wire, then refunds it under the failure rule', async () => {
    setEnhancerStepsWaitForTests(20);
    failingProvider((wire) => {
      const attempt = wire!.begin();

      attempt.started = true;
      attempt.messageIds.push('msg_broken');
      attempt.input = 640;
    });

    await enhance();

    await vi.waitFor(() => expect(finals().length).toBeGreaterThan(0), { timeout: 1500 });

    const row = finals().at(-1)!;

    expect(row.status).toBe('failed');
    expect(row.promptTokens, 'the wire attempt reached the bill').toBe(640);
    expect(row.creditsCharged).toBeGreaterThan(0);
    expect(await ledger.balance(USER), 'and the failure rule refunded it').toBe(1000);
  });

  it("hands the route's wire recorder to the model call", async () => {
    streamText.mockResolvedValue(fakeResult([{ type: 'text-delta', textDelta: 'a better prompt' }]));

    await enhance();
    await vi.waitFor(() => expect(finals().length).toBeGreaterThan(0));

    expect(typeof streamText.mock.calls[0][0].wireUsage?.begin).toBe('function');
  });
});

/**
 * 🔴 THE FAILURE WRITE KEEPS THE USAGE (no-unbilled-usage T8, a pre-existing records defect).
 *
 * The failure used to be a second upsert of `{ id, userId, model, status: 'failed' }` after settlement, and
 * the Postgres store writes every usage column from the payload (`input_tokens: row.promptTokens ?? 0`) — so
 * on production it ZEROED the tokens, credits and raw cost the anchor had just written. Asserted on the
 * PAYLOADS, because the FS store merges and would hide it.
 */
describe('a failed enhancement records its usage on every write', () => {
  it('no write marks it failed without the usage it consumed', async () => {
    streamText.mockResolvedValue(
      fakeResult(
        [
          { type: 'text-delta', textDelta: 'a bett' },
          { type: 'error', error: new Error('provider exploded') },
        ],
        [{ usage: { promptTokens: 295, completionTokens: 12 } }],
      ),
    );

    await enhance();
    await vi.waitFor(() => expect(finals().some((u) => u.status === 'failed')).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 20));

    for (const write of finals()) {
      expect(write.promptTokens, `write ${JSON.stringify(write)} would zero input_tokens`).toBe(295);
      expect(write.completionTokens).toBe(12);
      expect(write.creditsCharged).toBeGreaterThan(0);
    }
  });

  /* CONTROL — a delivered enhancement settles exactly once: one terminal write, one debit. */
  it('CONTROL: a normal enhancement bills once', async () => {
    streamText.mockResolvedValue(
      fakeResult(
        [{ type: 'text-delta', textDelta: 'a better prompt' }],
        [{ usage: { promptTokens: 295, completionTokens: 335 } }],
      ),
    );

    await enhance();
    await vi.waitFor(() => expect(finals().length).toBeGreaterThan(0));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(finals()).toHaveLength(1);
    expect(finals()[0].status).toBe('completed');

    const debits = (await ledger.list(USER)).filter((e) => e.reason === 'generation');

    expect(debits).toHaveLength(1);
  });
});
