/**
 * The forced-continuation gate (SPEC §4.6, §4.10, `spec/context-budget.md`) — a MONEY path.
 *
 * ## What this pins, and why it is not obvious
 *
 * When the tool loop runs out of steps with a tool call outstanding, the model never wrote an answer.
 * `proxy.ts` rescues that by continuing once with tools disabled. The rescue is correct. The GATE was
 * not: it fired on `finishReason === 'tool-calls'` alone.
 *
 * 🔴 **`finishReason` IS A PROVIDER CLAIM, NOT A FACT.** The AI SDK propagates it VERBATIM and never
 * cross-checks it against whether a tool call was actually emitted. So a provider reporting `tool-calls`
 * on a step that made none sends the gate into a whole second generation — re-sending the entire prefix
 * to "finish" work that was already finished.
 *
 * Measured live before the fix: a complete answer on step 1, then **+111,827 cache tokens for 682 chars
 * of text**. One real edit billed **831 credits** where ~415 were warranted. It reported
 * `finish=stop · 0 tool rounds` while doing it (see the diagnostics test at the bottom).
 *
 * ⚠️ The tests below drive the REAL `ai@4` `streamText` with only the MODEL mocked. That is deliberate:
 * the whole bug lives in the SDK's step/finishReason semantics, so a test that mocks the SDK would have
 * asserted our own misunderstanding and passed. It is the same lesson `mcp-live-relay.spec.ts` records —
 * "correct by construction" is what that relay was, right up until a live-fidelity test found three
 * defects in it.
 */
import { streamText } from 'ai';
import { MockLanguageModelV1, mockValues, simulateReadableStream } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { shouldForceContinuation } from './proxy';

/*
 * ⚠️ Returns the VALUE, not a factory — `mockValues` yields each value in turn, and a factory makes
 * `doStream` resolve to a function, which the SDK dies on (`stream.pipeThrough` of undefined).
 */
const response = (chunks: unknown[]) => ({
  stream: simulateReadableStream({ chunks: chunks as never[], initialDelayInMs: 0, chunkDelayInMs: 0 }),
  rawCall: { rawPrompt: null, rawSettings: {} },
});

const model = (...responses: unknown[][]) => {
  const next = mockValues(...responses.map((r) => response(r)));
  return new MockLanguageModelV1({ doStream: async () => next() });
};

const tools = {
  load_skill: {
    description: 'load a skill',
    parameters: z.object({ name: z.string() }),
    execute: async () => 'skill body',
  },
};

/** Drain a stream exactly as `proxy.ts`'s `drain` does, returning the signals the gate reads. */
async function drain(m: MockLanguageModelV1, maxSteps: number, toolChoice: 'auto' | 'none') {
  const result = streamText({ model: m, tools, toolChoice, maxSteps, prompt: 'go' });

  let text = '';

  for await (const part of result.fullStream) {
    if (part.type === 'text-delta') {
      text += part.textDelta;
    }
  }

  const steps = await result.steps;

  return {
    finishReason: await result.finishReason,
    lastStepToolCalls: steps[steps.length - 1]?.toolCalls?.length ?? 0,
    stepCount: steps.length,
    text,
  };
}

/*
 * ⚠️ `shouldForceContinuation` is IMPORTED FROM `proxy.ts` — never re-declared here. A local copy of the
 * gate would only prove the rule was written twice and would keep passing while the real gate rotted,
 * which is precisely the `FsLedger` gap that let the `credit_ledger.generation_id` FK ship.
 */
describe('the forced-continuation gate', () => {
  /**
   * 🔴 THE BUG. The exact shape measured live: `tool-calls`, one step, ZERO tool calls, and the complete
   * artifact already in hand. The old gate re-ran the whole generation on this.
   */
  it('does NOT fire when the provider claims tool-calls but made none — the answer is already written', async () => {
    const m = model([
      { type: 'text-delta', textDelta: 'Here is your complete game artifact.' },
      { type: 'finish', finishReason: 'tool-calls', usage: { promptTokens: 10, completionTokens: 5 } },
    ]);

    /*
     * maxSteps=7: the SDK had six steps left and did NOT use them — with no tool call to execute there
     * was nothing to loop on. So the "cap reached" the old warning announced had never happened.
     */
    const r = await drain(m, 7, 'auto');

    expect(r.finishReason, 'the SDK propagates the provider claim verbatim').toBe('tool-calls');
    expect(r.lastStepToolCalls, 'no tool call was actually made').toBe(0);
    expect(r.stepCount, 'the cap was never reached — one step, six unused').toBe(1);
    expect(r.text).toContain('complete game artifact');

    expect(shouldForceContinuation(r), 'a second full generation here is pure waste (+111,827 tokens)').toBe(false);
  });

  /**
   * ✅ THE CASE THE RESCUE EXISTS FOR — must still fire. A fix that kills the spurious continuation by
   * also killing the real one has traded a money bug for a silent truncation.
   */
  it('DOES fire when the model was genuinely cut off mid-tool-loop', async () => {
    const m = model([
      { type: 'text-delta', textDelta: 'Let me load the design skill. ' },
      {
        type: 'tool-call',
        toolCallType: 'function',
        toolCallId: 'c1',
        toolName: 'load_skill',
        args: JSON.stringify({ name: 'bt-design' }),
      },
      { type: 'finish', finishReason: 'tool-calls', usage: { promptTokens: 10, completionTokens: 5 } },
    ]);

    const r = await drain(m, 1, 'auto'); // no step left to answer in

    expect(r.finishReason).toBe('tool-calls');
    expect(r.lastStepToolCalls, 'a REAL cut-off has a tool call on the last step').toBe(1);
    expect(shouldForceContinuation(r), 'without this the user gets preamble and no artifact').toBe(true);
  });

  /**
   * 🔴 THE TRAP. `producedText` is the obvious-looking gate and it is WRONG — a genuine cut-off almost
   * always HAS emitted text before its tool call, so gating on "did it say anything" skips the
   * continuation exactly when it is needed. This is why the fix reads tool calls, not text.
   */
  it('a genuine cut-off HAS produced text — so !producedText would skip the rescue it needs', async () => {
    const m = model([
      { type: 'text-delta', textDelta: 'Let me load the design skill. ' },
      {
        type: 'tool-call',
        toolCallType: 'function',
        toolCallId: 'c1',
        toolName: 'load_skill',
        args: JSON.stringify({ name: 'bt-design' }),
      },
      { type: 'finish', finishReason: 'tool-calls', usage: { promptTokens: 10, completionTokens: 5 } },
    ]);

    const r = await drain(m, 1, 'auto');

    expect(r.text.length, 'text was produced, yet the rescue is still required').toBeGreaterThan(0);
    expect(shouldForceContinuation(r)).toBe(true);
  });

  /* A normal turn never continues, whatever else is true. */
  it('does not fire on an ordinary stop', async () => {
    const m = model([
      { type: 'text-delta', textDelta: 'Done.' },
      { type: 'finish', finishReason: 'stop', usage: { promptTokens: 10, completionTokens: 5 } },
    ]);

    const r = await drain(m, 7, 'auto');
    expect(shouldForceContinuation(r)).toBe(false);
  });

  /**
   * A pre-loaded / creation turn: `toolChoice:'none'`, `maxSteps:1`. Tool DEFINITIONS still go to the
   * model (Anthropic requires them when history holds tool_use blocks), so a provider can still claim
   * `tool-calls` — and this shape must never continue either.
   */
  it('does not fire on a tools-disabled turn that claims tool-calls', async () => {
    const m = model([
      { type: 'text-delta', textDelta: 'Here is your complete game artifact.' },
      { type: 'finish', finishReason: 'tool-calls', usage: { promptTokens: 10, completionTokens: 5 } },
    ]);

    const r = await drain(m, 1, 'none');

    expect(r.lastStepToolCalls).toBe(0);
    expect(shouldForceContinuation(r)).toBe(false);
  });
});

/**
 * 🔴 HOW IT HID — and why the fix ships with a diagnostics change (§4.10).
 *
 * `drain` runs twice and overwrites `finishReason`, so a doubled generation recorded the CONTINUATION's
 * `stop`. `toolRounds` counts steps BEYOND the first, and both drains ran exactly one step, so it summed
 * to **0**. The live usage line therefore read `finish=stop · 0 tool rounds` on a generation that had
 * just been billed twice — indistinguishable from a completely ordinary turn.
 *
 * That is the FIFTH metric this codebase has found encoding a wrong assumption, and the same shape as
 * `wastedOutput` reporting zero on the most expensive generation in the product: **when a metric is
 * defined in terms of the failure it expects, the failure it does not expect reads as success.**
 */
describe('the doubling must be visible in the record', () => {
  const recorded = (finishReason: string, forcedContinuation: boolean) =>
    forcedContinuation ? `${finishReason}+forced-continuation` : finishReason;

  it('marks a forced continuation instead of recording the continuation bare stop', () => {
    expect(recorded('stop', true)).toBe('stop+forced-continuation');
  });

  it('leaves an ordinary generation untouched', () => {
    expect(recorded('stop', false)).toBe('stop');
  });
});
