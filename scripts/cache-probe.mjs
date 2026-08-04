/**
 * KIE prompt-cache probe (`node scripts/cache-probe.mjs [requests] [delayMs]`).
 *
 * Answers one question with real money and no guessing: **when does a cached prefix actually start
 * paying?** Written 2026-07-26 after a day's generations showed `cacheRead: 0` on every turn — which
 * read like a broken cache and was in fact the warmup below, because prompt-affecting code was being
 * edited between generations and no prefix survived long enough to reach its 5th request.
 *
 * Sends the SAME request N times and reports what the provider says about the cache each time.
 * Mirrors the platform's exact shape: a system block with `cache_control: {type:'ephemeral', ttl:'1h'}`
 * (proxy.ts CACHE_CONTROL), same base URL, same model selection precedence.
 *
 * Deliberately tiny: a ~1.5k-token prefix (just over Anthropic's 1024 minimum for a cacheable block)
 * and max_tokens=1, so 12 requests cost a fraction of one real generation. The question is the HIT
 * PATTERN, which does not need a big prefix to answer.
 *
 * ## Family-aware since 2026-08-04
 *
 * The platform speaks three wires, and each reports caching differently — or not at all. Endpoint,
 * body and counter extraction are derived from `familyOf(model)`, the same rule as
 * `kie-model-health.mjs` and `stream-probe.mjs`:
 *
 * - **claude** → `/claude/v1/messages`, explicit `cache_control` breakpoint;
 *   `usage.{cache_read_input_tokens, cache_creation_input_tokens}` (the write counter is also served
 *   as a TIERED object, `cache_creation.{ephemeral_5m_input_tokens, ephemeral_1h_input_tokens}` —
 *   both shapes are summed here, because reading only the flat field reports a real write as zero).
 * - **codex** → `/codex/v1/responses` with the prefix as `instructions` (OpenAI caches prefixes
 *   automatically; there is no breakpoint to place); counters come off the `response.completed`
 *   event as `response.usage.input_tokens_details.{cached_tokens, cache_write_tokens}`. Captured
 *   verbatim 2026-08-04:
 *   `{"input_tokens_details":{"cache_write_tokens":0,"cached_tokens":0},"total_tokens":1186,
 *     "output_tokens":1186,"input_tokens":0,"output_tokens_details":{"reasoning_tokens":75}}`
 * - **gemini** → `:streamGenerateContent?alt=sse`. **There is NO cached-token counter at all**, and
 *   KIE prices no Gemini caching, so this probe prints an explicit "not reported" note rather than
 *   printing zeros that would read as a measured cache miss. `usageMetadata` captured verbatim
 *   2026-08-04: `{"thinkingTokenCount":770,"candidatesTokenCount":1226,"totalTokenCount":2105,
 *   "promptTokenCount":109}` — prompt/candidates/thinking/total, and nothing else.
 *
 * ## ⚠️ KIE reports faults as HTTP 200
 *
 * Measured live 2026-08-04: a KIE fault arrives as **HTTP 200 with a JSON envelope**
 * `{"code":N,"msg":"..."}`, not an HTTP error status. Every request below therefore inspects the
 * BODY, never just `response.ok` — a probe that trusts the status counts a dead model's faults as
 * cache misses and reports a caching problem that does not exist.
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

const KEY = env.KIE_API_KEY;

/*
 * `PROBE_MODEL=<id>` overrides the configured model, and it is the whole reason this probe can
 * produce a trustworthy answer rather than a plausible one (added 2026-07-30).
 *
 * A probe that can only ever read `.env.local` can only ever measure ONE model, so every result it
 * gives is uncontrolled — and this file's own header records what that costs: a six-request run was
 * read as "KIE randomly drops ~1/3 of cache entries" and came within one env var of buying a 2.5x
 * more expensive provider to fix a defect that did not exist. The first run under the new
 * `claude-sonnet-5` default hit `HTTP 500` on 7 of 8 requests, which reads exactly like "the new
 * model is broken" until the identical run on the OLD model does the same thing and reveals a
 * provider-wide blip. The control is what makes a rate mean anything.
 */
const MODEL = process.env.PROBE_MODEL?.trim() || env.LLM_MODEL || env.KIE_DEFAULT_MODEL || 'claude-sonnet-5';

const CLAUDE_BASE = env.KIE_BASE_URL || 'https://api.kie.ai/claude/v1';
const CODEX_BASE = env.KIE_CODEX_BASE_URL || 'https://api.kie.ai/codex/v1';
const GEMINI_BASE = env.KIE_GEMINI_BASE_URL || 'https://api.kie.ai/gemini/v1';

if (!KEY) {
  throw new Error('no KIE_API_KEY in .env.local');
}

/**
 * The family a model id belongs to — the same prefix rule as `app/lib/modules/llm/model-families.ts`.
 * Duplicated rather than imported because this is a plain `.mjs` script with no TS pipeline; keep the
 * two in step. A probe that guessed the wrong wire would report a healthy cache as absent.
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

const FAMILY = familyOf(MODEL);

// ~1.5k tokens of stable filler — the cacheable prefix.
const PREFIX = 'The quick brown fox jumps over the lazy dog. '.repeat(300);
const SYSTEM_TEXT = `You are a cache probe. Reference text follows.\n\n${PREFIX}`;

const N = Number(process.argv[2] || 12);
const DELAY_MS = Number(process.argv[3] || 3000);

/** Endpoint, headers and body for one probe request, derived from the model's FAMILY. */
function cacheRequest() {
  if (FAMILY === 'codex') {
    return {
      url: `${CODEX_BASE}/responses`,
      headers: {},
      /*
       * OpenAI caches long prefixes automatically — there is no breakpoint to place — so the stable
       * bytes go in `instructions`, which is what leads the prompt on this wire. `stream: true`
       * because the counters ride the `response.completed` event.
       */
      body: {
        model: MODEL,
        instructions: SYSTEM_TEXT,
        input: [{ role: 'user', content: 'ok' }],
        max_output_tokens: 16,
        reasoning: { effort: 'low' },
        stream: true,
      },
    };
  }

  if (FAMILY === 'gemini') {
    return {
      url: `${GEMINI_BASE}/models/${MODEL}:streamGenerateContent?alt=sse`,
      headers: {},
      body: {
        systemInstruction: { parts: [{ text: SYSTEM_TEXT }] },
        contents: [{ role: 'user', parts: [{ text: 'ok' }] }],
        generationConfig: { maxOutputTokens: 16 },
      },
    };
  }

  return {
    url: `${CLAUDE_BASE}/messages`,
    headers: { 'anthropic-version': '2023-06-01' },
    body: {
      model: MODEL,
      max_tokens: 1,
      system: [{ type: 'text', text: SYSTEM_TEXT, cache_control: { type: 'ephemeral', ttl: '1h' } }],
      messages: [{ role: 'user', content: 'ok' }],
    },
  };
}

/**
 * Claude's cache-WRITE counter is served two ways: a flat `cache_creation_input_tokens` and a tiered
 * `cache_creation` object split by TTL. Reading only the flat field reports a real 1h-tier write as
 * zero — i.e. "no cache at all" on a request that just paid 2x for one.
 */
function claudeWrite(usage) {
  const tiered = usage?.cache_creation ?? {};

  return (
    (usage?.cache_creation_input_tokens ?? 0) ||
    (tiered.ephemeral_1h_input_tokens ?? 0) + (tiered.ephemeral_5m_input_tokens ?? 0)
  );
}

/** Pull the cache counters out of a response body, per family. */
function countersFrom(family, raw) {
  if (family === 'claude') {
    const json = JSON.parse(raw);

    /* KIE's HTTP-200 fault envelope — never an error status, so the body is the only signal. */
    if (json.code && json.code !== 200) {
      return { error: `API ERROR ${JSON.stringify(json).slice(0, 200)}` };
    }

    const usage = json.usage ?? {};

    return { write: claudeWrite(usage), read: usage.cache_read_input_tokens ?? 0, fresh: usage.input_tokens ?? 0 };
  }

  /* SSE families: walk `data:` lines and keep the last usage report seen. */
  let usage = null;

  for (const line of raw.split('\n')) {
    if (!line.startsWith('data: ')) {
      continue;
    }

    let event;

    try {
      event = JSON.parse(line.slice(6));
    } catch {
      continue;
    }

    if (family === 'codex' && event?.type === 'response.completed') {
      usage = event.response?.usage ?? null;
    }

    if (family === 'gemini' && event?.usageMetadata) {
      usage = event.usageMetadata;
    }
  }

  if (!usage) {
    const envelope = raw.match(/"msg"\s*:\s*"([^"]+)"/);

    return { error: envelope ? `API ERROR ${envelope[1]}` : `no usage in body: ${raw.slice(0, 160)}` };
  }

  if (family === 'codex') {
    const details = usage.input_tokens_details ?? {};

    return {
      write: details.cache_write_tokens ?? 0,
      read: details.cached_tokens ?? 0,
      fresh: usage.input_tokens ?? 0,
    };
  }

  /*
   * Gemini reports promptTokenCount / candidatesTokenCount / thinkingTokenCount / totalTokenCount and
   * NOTHING about caching. Reporting 0/0 here would be a measurement that was never taken.
   */
  return { write: null, read: null, fresh: usage.promptTokenCount ?? 0 };
}

const { url, headers, body } = cacheRequest();

console.log(
  `model=${MODEL}  family=${FAMILY}  requests=${N}  delay=${DELAY_MS}ms  prefix≈${Math.round(PREFIX.length / 4)} tokens\n`,
);

if (FAMILY === 'gemini') {
  console.log(
    '  NOTE: the gemini family reports NO cached-token counter (usageMetadata carries prompt/candidates/\n' +
      '  thinking/total only), and KIE prices no Gemini caching. The write/read columns below read "n/a"\n' +
      '  because nothing was measured — they are not zeros.\n',
  );
}

console.log('  #   ms      write     read    fresh   verdict');

let hits = 0;
let measured = 0;

for (let i = 1; i <= N; i++) {
  const t0 = Date.now();

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}`, ...headers },
    body: JSON.stringify(body),
  });

  const ms = Date.now() - t0;
  const raw = await res.text();

  if (!res.ok) {
    console.log(`  ${String(i).padStart(2)}  ${String(ms).padStart(5)}  HTTP ${res.status} ${raw.slice(0, 160)}`);
    continue;
  }

  let counters;

  try {
    counters = countersFrom(FAMILY, raw);
  } catch (error) {
    counters = { error: `unparseable body (${String(error?.message ?? error).slice(0, 60)}): ${raw.slice(0, 120)}` };
  }

  if (counters.error) {
    console.log(`  ${String(i).padStart(2)}  ${String(ms).padStart(5)}  ${counters.error}`);
    continue;
  }

  const { write, read, fresh } = counters;
  const reported = read !== null && write !== null;
  const verdict = reported ? (read > 0 ? 'HIT' : write > 0 ? 'miss (wrote)' : 'no cache at all') : 'not reported';

  if (reported) {
    measured++;
  }

  if (reported && read > 0) {
    hits++;
  }

  console.log(
    `  ${String(i).padStart(2)}  ${String(ms).padStart(5)}  ${String(write ?? 'n/a').padStart(9)} ${String(read ?? 'n/a').padStart(8)} ${String(fresh).padStart(8)}   ${verdict}`,
  );

  if (i < N) {
    await new Promise((r) => setTimeout(r, DELAY_MS));
  }
}

if (FAMILY === 'gemini') {
  console.log('\nNo cache counters exist on this wire — this run measured latency and prompt size only.');
} else {
  console.log(
    `\n${hits}/${measured} measured requests hit the cache (of ${N} attempted). Requests 2..N SHOULD all hit — request 1 is the write.`,
  );
}
