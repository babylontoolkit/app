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
const MODEL = env.LLM_MODEL || env.KIE_DEFAULT_MODEL || 'claude-opus-5';
const BASE = 'https://api.kie.ai/claude/v1';

if (!KEY) {
  throw new Error('no KIE_API_KEY in .env.local');
}

// ~1.5k tokens of stable filler — the cacheable prefix.
const PREFIX = ('The quick brown fox jumps over the lazy dog. ').repeat(300);

const N = Number(process.argv[2] || 12);
const DELAY_MS = Number(process.argv[3] || 3000);

const body = {
  model: MODEL,
  max_tokens: 1,
  system: [
    {
      type: 'text',
      text: `You are a cache probe. Reference text follows.\n\n${PREFIX}`,
      cache_control: { type: 'ephemeral', ttl: '1h' },
    },
  ],
  messages: [{ role: 'user', content: 'ok' }],
};

console.log(`model=${MODEL}  requests=${N}  delay=${DELAY_MS}ms  prefix≈${Math.round(PREFIX.length / 4)} tokens\n`);
console.log('  #   ms      write     read    fresh   verdict');

let hits = 0;

for (let i = 1; i <= N; i++) {
  const t0 = Date.now();

  const res = await fetch(`${BASE}/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${KEY}`,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });

  const ms = Date.now() - t0;
  const json = await res.json();

  if (!res.ok) {
    console.log(`  ${String(i).padStart(2)}  ${String(ms).padStart(5)}  HTTP ${res.status} ${JSON.stringify(json).slice(0, 160)}`);
    continue;
  }

  if (json.code && json.code !== 200) {
    console.log(`  ${String(i).padStart(2)}  ${String(ms).padStart(5)}  API ERROR ${JSON.stringify(json).slice(0, 200)}`);
    continue;
  }
  const u = json.usage ?? {};
  const write = u.cache_creation_input_tokens ?? 0;
  const read = u.cache_read_input_tokens ?? 0;
  const fresh = u.input_tokens ?? 0;
  const verdict = read > 0 ? 'HIT' : write > 0 ? 'miss (wrote)' : 'no cache at all';

  if (read > 0) {
    hits++;
  }

  console.log(
    `  ${String(i).padStart(2)}  ${String(ms).padStart(5)}  ${String(write).padStart(9)} ${String(read).padStart(8)} ${String(fresh).padStart(8)}   ${verdict}`,
  );

  if (i < N) {
    await new Promise((r) => setTimeout(r, DELAY_MS));
  }
}

console.log(`\n${hits}/${N} hit the cache. Requests 2..N SHOULD all hit — request 1 is the write.`);
