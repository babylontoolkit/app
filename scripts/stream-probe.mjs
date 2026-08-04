/**
 * Streaming-liveness probe (`node scripts/stream-probe.mjs [model] [maxTokens]`).
 *
 * Answers ONE question that no server-side number can: when the model produces a long answer, do the
 * bytes reach us PROGRESSIVELY, or in one lump at the end?
 *
 * Written 2026-08-03, after a first-build turn showed 3+ minutes of dead spinner and then ~46KB of
 * artifact at once. The persisted step log said `244505ms · 16985 out (69 tok/s)` — a perfectly
 * healthy decode rate — because the server's own totals cannot tell "streamed for 244s" apart from
 * "buffered for 244s and arrived at 244s". Both look identical from the outside.
 *
 * Made FAMILY-AWARE 2026-08-04: the platform now speaks three wires (Claude messages, Codex
 * responses, Gemini generateContent), and `deliveryMode` is keyed by provider+family — so a probe
 * that could only ask the Claude endpoint could only ever answer the question for one third of the
 * catalogue. Endpoint, request body and SSE delta extraction are all derived from `familyOf(model)`,
 * exactly as in `kie-model-health.mjs`.
 *
 * Sibling of `cache-probe.mjs` and `kie-model-health.mjs`, and shaped by the same two lessons:
 *
 * - **Always run the control.** `spec/context-budget.md` records a KIE cache "failure" that was a
 *   warmup artefact and came within one env var of buying a 2.5x more expensive provider. The same
 *   request goes to api.anthropic.com so a provider fault cannot be confused with a model fault.
 *   The control only exists for the Claude family — it is SKIPPED with a printed note for the other
 *   two, because "no control was run" and "the control passed" must never look the same.
 * - **Read the distribution, never the total.** The output here is a gap histogram plus the single
 *   largest silence. A stream that delivers everything in the last delta and a stream that trickles
 *   for four minutes have the SAME char count, the same token count and the same duration.
 *
 * ## ⚠️ KIE reports faults as HTTP 200
 *
 * Measured live 2026-08-04: a KIE fault arrives as **HTTP 200 with a JSON envelope**
 * `{"code":N,"msg":"..."}` — not an HTTP error status, and not an SSE stream at all. A probe that
 * trusts `response.ok` reports a dead model as "0 deltas, cause unknown". This file therefore keeps
 * the raw body and re-reads it for that envelope whenever no deltas arrived, the same way
 * `kie-model-health.mjs` does.
 *
 * ## Recorded baseline (2026-08-04, live against real KIE)
 *
 * | family | model             | total    | deltas | chars | first delta   | final-second share | verdict  |
 * |--------|-------------------|----------|--------|-------|---------------|--------------------|----------|
 * | codex  | gpt-5-6-sol       | 46498ms  | 2382   | 9576  | 3016ms (6%)   | 1.0%               | STREAMED |
 * | gemini | gemini-3-5-flash  | 12542ms  | 19     | 6828  | 5650ms (45%)  | 6.8%               | STREAMED |
 * | claude | claude-opus-5     |  9340ms  | 0      | —     | —             | —                  | NO TEXT  |
 *
 * The Gemini row is the big-answer confirmation that was owed: 19 deltas is few, but they are spread
 * across the run and only 6.8% of the text lands in the final second, so the wire is live rather than
 * batched — a buffered provider puts essentially ALL of it there (KIE's Claude adapter measured
 * 26,539 chars, 100% in the final second, after 130s of silence).
 *
 * The Claude row is NOT a streaming verdict. KIE was returning `"Server exception"` for most Claude
 * models that day, so there was no text to time — read it as "unmeasurable on 2026-08-04", re-run
 * before quoting it, and see the HTTP-200 note above for why a zero-delta run needs its body read.
 *
 * Cost is bounded by `maxTokens` (default 6000): a few cents on KIE, ~2.5x that on the control.
 */
import { readFileSync } from 'node:fs';

const envText = readFileSync(new URL('../.env.local', import.meta.url), 'utf-8');
const env = Object.fromEntries(
  envText
    .split('\n')
    .filter((l) => l.trim() && !l.trim().startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')];
    }),
);

const CLAUDE_BASE = env.KIE_BASE_URL || 'https://api.kie.ai/claude/v1';
const CODEX_BASE = env.KIE_CODEX_BASE_URL || 'https://api.kie.ai/codex/v1';
const GEMINI_BASE = env.KIE_GEMINI_BASE_URL || 'https://api.kie.ai/gemini/v1';

/**
 * The family a model id belongs to — the same prefix rule as `app/lib/modules/llm/model-families.ts`.
 * Duplicated rather than imported because this is a plain `.mjs` script with no TS pipeline; keep the
 * two in step. A probe that guessed the wrong wire would report a healthy model as silent.
 */
function familyOf(model) {
  if (model.startsWith('claude-')) {
    return 'claude';
  }

  if (model.startsWith('gpt-')) {
    return 'codex';
  }

  if (model.startsWith('gemini-')) {
    return 'gemini';
  }

  throw new Error(`unknown family for "${model}" — add its prefix here and in model-families.ts`);
}

/*
 * `[model] [maxTokens]` in either order: an argument that parses as a number is the token cap, and
 * anything else is the model id. The first argument used to be `maxTokens` alone, so accepting both
 * orders keeps every existing invocation working unchanged.
 */
let MODEL = 'claude-opus-5';
let MAX_TOKENS = 6000;

for (const arg of process.argv.slice(2)) {
  const asNumber = Number(arg);

  if (arg.trim() !== '' && Number.isFinite(asNumber)) {
    MAX_TOKENS = asNumber;
  } else {
    MODEL = arg.trim();
  }
}

const FAMILY = familyOf(MODEL);

/*
 * A prompt that produces a LOT of plain text and almost no reasoning — the shape of the failing turn
 * (step 2 was 46,476 chars of artifact against 1,725 chars of thinking). A puzzle prompt would
 * measure the think window instead, which is a different question with a different known answer.
 */
const PROMPT =
  'Write out a complete TypeScript module that implements a kart racing lap timer: checkpoint ' +
  'tracking, split times, best-lap storage, and a small event emitter. Include full JSDoc on every ' +
  'export and do not abbreviate anything. Write the code directly with no preamble.';

/**
 * The text carried by ONE SSE event, per family. Returns `''` for every event that is not visible
 * answer text — thinking is a different channel and a different question.
 *
 * ⚠️ Gemini's SSE lines carry NO `type` field: each `data:` line is a bare `generateContent` chunk,
 * so it must be recognised by SHAPE (`candidates[].content.parts[]`) rather than by an event name.
 * Its `thought: true` parts are the reasoning channel and are excluded here.
 */
function textOf(family, event) {
  if (family === 'codex') {
    return event?.type === 'response.output_text.delta' ? (event.delta ?? '') : '';
  }

  if (family === 'gemini') {
    const parts = event?.candidates?.[0]?.content?.parts ?? [];

    return parts
      .filter((p) => !p?.thought)
      .map((p) => p?.text ?? '')
      .join('');
  }

  return event?.type === 'content_block_delta' && event?.delta?.type === 'text_delta' ? (event.delta.text ?? '') : '';
}

/** Endpoint + base body for a streamed request, derived from the model's FAMILY. */
function streamRequest(model, maxTokens) {
  const family = familyOf(model);

  if (family === 'codex') {
    return {
      url: `${CODEX_BASE}/responses`,
      headers: {},
      body: {
        model,
        input: [{ role: 'user', content: PROMPT }],
        max_output_tokens: maxTokens,
        reasoning: { effort: 'low' },
        stream: true,
      },
    };
  }

  if (family === 'gemini') {
    return {
      url: `${GEMINI_BASE}/models/${model}:streamGenerateContent?alt=sse`,
      headers: {},
      body: {
        contents: [{ role: 'user', parts: [{ text: PROMPT }] }],
        generationConfig: {
          maxOutputTokens: maxTokens,
          thinkingConfig: { includeThoughts: true, thinkingLevel: 'low' },
        },
      },
    };
  }

  return {
    url: `${CLAUDE_BASE}/messages`,
    headers: { 'anthropic-version': '2023-06-01' },
    body: { model, max_tokens: maxTokens, stream: true, messages: [{ role: 'user', content: PROMPT }] },
  };
}

/** One streamed request, timing every text delta as it lands. */
async function probe(label, family, url, headers, body) {
  const started = Date.now();
  const deltas = [];
  let chars = 0;
  let firstByteAt = null;
  let raw = '';

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(600_000),
  });

  if (!response.ok) {
    console.log(`\n${label}: HTTP ${response.status} ${(await response.text()).slice(0, 200)}`);
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    firstByteAt ??= Date.now() - started;

    const chunk = decoder.decode(value, { stream: true });
    raw += chunk;
    buffer += chunk;

    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (!line.startsWith('data: ')) {
        continue;
      }

      let event;

      try {
        event = JSON.parse(line.slice(6));
      } catch {
        continue;
      }

      const text = textOf(family, event);

      if (text) {
        deltas.push({ at: Date.now() - started, len: text.length });
        chars += text.length;
      }
    }
  }

  const total = Date.now() - started;

  if (deltas.length === 0) {
    /*
     * A KIE fault is an HTTP 200 carrying `{"code":N,"msg":"..."}` — never an error status and never
     * an SSE stream. Without this the run reports "no deltas" and hides the reason in the body.
     */
    const envelope = raw.match(/"msg"\s*:\s*"([^"]+)"/);

    console.log(
      `\n${label}: no text deltas in ${total}ms (first byte ${firstByteAt}ms)` +
        (envelope ? `\n  provider fault (HTTP 200 envelope): ${envelope[1]}` : `\n  body: ${raw.slice(0, 200)}`),
    );
    return;
  }

  const first = deltas[0].at;
  const last = deltas[deltas.length - 1].at;

  // The largest silence BETWEEN text deltas — the number the user actually experiences as "frozen".
  let maxGap = first;
  let maxGapAt = 0;
  let prev = 0;

  for (const d of deltas) {
    if (d.at - prev > maxGap) {
      maxGap = d.at - prev;
      maxGapAt = prev;
    }

    prev = d.at;
  }

  /*
   * The share of the text that landed in the final second. A buffered stream puts nearly all of it
   * there; a live stream puts a sliver. This is the single discriminating number.
   */
  const tailChars = deltas.filter((d) => d.at > last - 1000).reduce((n, d) => n + d.len, 0);

  console.log(`\n${label}`);
  console.log(`  total            ${total}ms   (${chars} chars in ${deltas.length} text deltas)`);
  console.log(`  first byte       ${firstByteAt}ms`);
  console.log(`  first text       ${first}ms      last text ${last}ms`);
  console.log(`  longest silence  ${maxGap}ms  (starting at ${maxGapAt}ms)`);
  console.log(`  chars in final second  ${tailChars} of ${chars}  (${Math.round((tailChars / chars) * 100)}%)`);
  console.log(`  verdict          ${tailChars / chars > 0.5 ? 'BUFFERED — text withheld until the end' : 'STREAMING'}`);
}

const { url, headers, body: baseBody } = streamRequest(MODEL, MAX_TOKENS);

/*
 * Production shape first, then — for Claude only — the same request with each thinking knob removed.
 *
 * That is the question that decides whether the buffering is a wall or a workaround: if KIE streams
 * with thinking off, the platform has a lever it already owns (`canDisableThinking` /
 * `retryThinkingMode` in `retry-policy.ts`). If it buffers either way, the fault is the adapter's
 * transport and no request shape we can send will fix it.
 *
 * The other two families have no equivalent knob on the KIE wire, so they get the production shape
 * once rather than three near-identical paid runs.
 */
const KIE_VARIANTS =
  FAMILY === 'claude'
    ? [
        {
          label: 'production shape (adaptive+summarized, thinkingFlag)',
          body: {
            // Mirror what the proxy actually sends (`kie-wire.ts`), or this measures a request we never make.
            thinking: { type: 'adaptive', display: 'summarized' },
            output_config: { effort: 'medium' },
            thinkingFlag: true,
          },
        },
        {
          label: 'thinking DISABLED',
          body: { thinking: { type: 'disabled' } },
        },
        {
          label: 'no thinking fields at all',
          body: {},
        },
      ]
    : [{ label: 'production shape', body: {} }];

if (env.KIE_API_KEY) {
  for (const variant of KIE_VARIANTS) {
    await probe(
      `KIE  ${MODEL}  [${FAMILY}]  — ${variant.label}`,
      FAMILY,
      url,
      { authorization: `Bearer ${env.KIE_API_KEY}`, ...headers },
      { ...baseBody, ...variant.body },
    );
  }
}

/*
 * The control is Claude-only by construction: api.anthropic.com serves no GPT or Gemini model, so
 * there is nothing to compare a non-Claude run against. Say so out loud — a silently absent control
 * is indistinguishable from one that passed, which is the exact confusion this family of scripts
 * exists to prevent.
 */
if (FAMILY !== 'claude') {
  console.log(
    `\nANTHROPIC control: SKIPPED — ${MODEL} is the ${FAMILY} family and api.anthropic.com does not serve it.` +
      '\n  This run has NO control: a fault here cannot be told apart from a provider-wide blip.',
  );
} else if (env.ANTHROPIC_API_KEY) {
  await probe(
    `ANTHROPIC  ${MODEL}  (control)`,
    'claude',
    'https://api.anthropic.com/v1/messages',
    { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    { ...baseBody, thinking: { type: 'adaptive', display: 'summarized' }, output_config: { effort: 'medium' } },
  );
}
