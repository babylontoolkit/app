/**
 * Streaming-liveness probe (`node scripts/stream-probe.mjs [maxTokens]`).
 *
 * Answers ONE question that no server-side number can: when the model produces a long answer, do the
 * bytes reach us PROGRESSIVELY, or in one lump at the end?
 *
 * Written 2026-08-03, after a first-build turn showed 3+ minutes of dead spinner and then ~46KB of
 * artifact at once. The persisted step log said `244505ms · 16985 out (69 tok/s)` — a perfectly
 * healthy decode rate — because the server's own totals cannot tell "streamed for 244s" apart from
 * "buffered for 244s and arrived at 244s". Both look identical from the outside.
 *
 * Sibling of `cache-probe.mjs` and `kie-model-health.mjs`, and shaped by the same two lessons:
 *
 * - **Always run the control.** `spec/context-budget.md` records a KIE cache "failure" that was a
 *   warmup artefact and came within one env var of buying a 2.5x more expensive provider. The same
 *   request goes to api.anthropic.com so a provider fault cannot be confused with a model fault.
 * - **Read the distribution, never the total.** The output here is a gap histogram plus the single
 *   largest silence. A stream that delivers everything in the last delta and a stream that trickles
 *   for four minutes have the SAME char count, the same token count and the same duration.
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

const MAX_TOKENS = Number(process.argv[2] ?? 6000);
const MODEL = 'claude-opus-5';

/*
 * A prompt that produces a LOT of plain text and almost no reasoning — the shape of the failing turn
 * (step 2 was 46,476 chars of artifact against 1,725 chars of thinking). A puzzle prompt would
 * measure the think window instead, which is a different question with a different known answer.
 */
const PROMPT =
  'Write out a complete TypeScript module that implements a kart racing lap timer: checkpoint ' +
  'tracking, split times, best-lap storage, and a small event emitter. Include full JSDoc on every ' +
  'export and do not abbreviate anything. Write the code directly with no preamble.';

/** One streamed request, timing every text delta as it lands. */
async function probe(label, url, headers, body) {
  const started = Date.now();
  const deltas = [];
  let chars = 0;
  let firstByteAt = null;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', ...headers },
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
    buffer += decoder.decode(value, { stream: true });

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

      // `text_delta` only: thinking deltas are a different channel and a different question.
      const text = event?.delta?.type === 'text_delta' ? event.delta.text : '';

      if (text) {
        deltas.push({ at: Date.now() - started, len: text.length });
        chars += text.length;
      }
    }
  }

  const total = Date.now() - started;

  if (deltas.length === 0) {
    console.log(`\n${label}: no text deltas in ${total}ms (first byte ${firstByteAt}ms)`);
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

const base = { model: MODEL, max_tokens: MAX_TOKENS, stream: true, messages: [{ role: 'user', content: PROMPT }] };

/*
 * Production shape first, then the same request with each thinking knob removed.
 *
 * This is the question that decides whether the buffering is a wall or a workaround: if KIE streams
 * with thinking off, the platform has a lever it already owns (`canDisableThinking` /
 * `retryThinkingMode` in `retry-policy.ts`). If it buffers either way, the fault is the adapter's
 * transport and no request shape we can send will fix it.
 */
const KIE_VARIANTS = [
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
];

if (env.KIE_API_KEY) {
  for (const variant of KIE_VARIANTS) {
    await probe(
      `KIE  ${MODEL}  — ${variant.label}`,
      `${env.KIE_BASE_URL || 'https://api.kie.ai/claude/v1'}/messages`,
      { authorization: `Bearer ${env.KIE_API_KEY}` },
      { ...base, ...variant.body },
    );
  }
}

if (env.ANTHROPIC_API_KEY) {
  await probe(
    `ANTHROPIC  ${MODEL}  (control)`,
    'https://api.anthropic.com/v1/messages',
    { 'x-api-key': env.ANTHROPIC_API_KEY },
    { ...base, thinking: { type: 'adaptive', display: 'summarized' }, output_config: { effort: 'medium' } },
  );
}
