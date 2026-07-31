/**
 * KIE catalogue health probe (`node scripts/kie-model-health.mjs [rounds]`).
 *
 * Answers "which Claude models will KIE actually serve right now?" — a question that has twice
 * decided what the platform ships, and that no test can answer because nothing in the suite touches
 * the live provider.
 *
 * Written 2026-07-31, when `DEFAULT_MODEL` had just been moved to `claude-sonnet-5` and the tree was
 * green at 3,811 tests while the shipped default could not complete a single generation. Sibling of
 * `cache-probe.mjs`, which exists for the same reason: the warning in a doc comment did not stop
 * anyone repeating the mistake, so the check became a committed command.
 *
 * ## Why it is shaped like this
 *
 * **Interleaved and order-rotated.** Every model is tried once per round, and the starting model
 * rotates, so a provider blip cannot masquerade as a model fault and no model is permanently
 * advantaged by going first. This is the shape that produced a trustworthy answer on 2026-07-30
 * (sonnet-5 7/30 against opus-5's 21/22) and it is the shape to keep: a rate from a single sample is
 * not a rate, and a clustered failure is a pattern rather than a ratio — read the round grid, not
 * just the percentage.
 *
 * **Cheap by construction.** `max_tokens: 1` and no cached prefix, so a failing model costs nothing
 * and a passing one costs a rounding error. Availability is the question; cost is not.
 *
 * **Both `thinkingFlag` states.** It is KIE-proprietary (`kie-wire.ts`), so a failure that only
 * appears with it on would otherwise look like a model fault.
 *
 * ## Baseline (2026-07-31, 136 requests)
 *
 * KIE served **2 of the 10 Claude models it prices**: `claude-opus-5` (22/22) and `claude-opus-4-8`
 * (12/12). Every other model returned `HTTP 500 "Network error"` in ~1.5s on every attempt —
 * sonnet-5, sonnet-4-6, sonnet-4-5, opus-4-7, opus-4-6, opus-4-5, haiku-4-5, fable-5.
 *
 * That pattern is why this script probes the CATALOGUE rather than one model. The 2026-07-30 run
 * sampled only sonnet-5 and opus-5 and concluded "sonnet-5 is broken"; with the full list in view the
 * shape is an outage that spared one model line — it had taken down `claude-fable-5` (the premium
 * model days earlier) and `claude-opus-4-7` (a former platform default) too. **A one-model probe
 * cannot distinguish a model fault from an outage.** Re-run to find out whether it has cleared.
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

if (!KEY) {
  throw new Error('no KIE_API_KEY in .env.local');
}

const BASE = env.KIE_BASE_URL || 'https://api.kie.ai/claude/v1';
const ROUNDS = Number(process.argv[2] ?? 6);

/**
 * Every Claude model the baked price list carries — keep in step with `baked-market-prices.ts`.
 * A model priced but never probed is a model nobody has checked the provider will serve.
 */
const MODELS = [
  'claude-opus-5',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-opus-4-5',
  'claude-sonnet-5',
  'claude-sonnet-4-6',
  'claude-sonnet-4-5',
  'claude-haiku-4-5',
  'claude-fable-5',
];

async function attempt(model, thinkingFlag) {
  const body = { model, max_tokens: 1, messages: [{ role: 'user', content: 'ok' }] };

  if (thinkingFlag) {
    body.thinkingFlag = true;
  }

  try {
    const response = await fetch(`${BASE}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });

    if (response.ok) {
      return { ok: true };
    }

    const text = await response.text();

    return { ok: false, note: `${response.status} ${(text.match(/"message":"([^"]+)"/) ?? [])[1] ?? ''}`.trim() };
  } catch (error) {
    return { ok: false, note: String(error?.message ?? error).slice(0, 60) };
  }
}

console.log(`KIE catalogue health — ${ROUNDS} rounds x ${MODELS.length} models x thinkingFlag on/off\n`);

const tally = Object.fromEntries(MODELS.map((m) => [m, { ok: 0, fail: 0, notes: new Set() }]));

for (let round = 0; round < ROUNDS; round++) {
  const shift = round % MODELS.length;
  const order = MODELS.slice(shift).concat(MODELS.slice(0, shift));
  const marks = [];

  for (const model of order) {
    let roundOk = 0;

    for (const flag of [true, false]) {
      const result = await attempt(model, flag);

      if (result.ok) {
        roundOk++;
        tally[model].ok++;
      } else {
        tally[model].fail++;
        tally[model].notes.add(result.note);
      }
    }

    // One mark per model per round, from THIS round only: '.' both fine, '~' one of two, 'X' both dead.
    marks.push(`${model.replace('claude-', '')}:${['X', '~', '.'][roundOk]}`);
  }

  console.log(`  round ${String(round + 1).padStart(2)}  ${marks.join('  ')}`);
}

console.log('\n  model                 ok   fail   fail-rate   error');

for (const model of MODELS) {
  const { ok, fail, notes } = tally[model];
  const rate = `${((fail / Math.max(1, ok + fail)) * 100).toFixed(0)}%`;
  console.log(
    `  ${model.padEnd(20)} ${String(ok).padStart(3)}  ${String(fail).padStart(5)}   ${rate.padStart(6)}     ${[...notes].join(' | ')}`,
  );
}

const dead = MODELS.filter((m) => tally[m].ok === 0);
const healthy = MODELS.filter((m) => tally[m].fail === 0);

console.log(`\n  healthy (0 failures): ${healthy.join(', ') || 'NONE'}`);
console.log(`  unserveable (0 successes): ${dead.join(', ') || 'none'}`);
console.log(
  '\n  A model here is only usable if it is ALSO priced (baked-market-prices.ts) and LISTED (kie-wire.ts).',
);
