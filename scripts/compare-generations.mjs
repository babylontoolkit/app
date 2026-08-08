/**
 * Compare what real generations actually cost, side by side (`node scripts/compare-generations.mjs`).
 *
 * Written 2026-08-08 to answer the one question the token math never could: **is the expensive model
 * worth it?** Every measurement in `_specs/creation-cost_plan.md` prices a turn; none of them judge the
 * game that came out of it. This prints the price so the human can go and judge the game.
 *
 * Reads `.data/generations/gen_*.json` — the diagnostics migration 0002 columns, written by
 * `settleGeneration` on every turn — and prints one row per generation, newest last.
 *
 * ## Reading the output
 *
 * - **cWrite** is billed at **2x** input (the 1h cache tier) and **cRead** at **0.1x**. A first run on a
 *   given model is always a cold write; a second run on the SAME model minutes later is a warm read.
 *   Comparing three DIFFERENT models is therefore apples to apples — each pays its own cold write,
 *   because the cache is keyed per model.
 * - **out** is the other half of the bill and costs 5x input. It is driven by how much code the game
 *   needed, not by any setting, so it is the column that varies most between two runs of the same
 *   prompt on the same model.
 * - **rawUSD** is true provider spend before margin. **credits** is what the user was charged, and
 *   since 2026-08-07 (Phase 1) it prices cache WRITES at the read rate — so `credits` deliberately does
 *   NOT track `rawUSD` on a cold turn. That gap is the platform absorbing the cold start, by design.
 * - **finish** of `stop` is a clean end. `stop+forced-continuation` means the turn was re-billed to
 *   finish an answer — a whole extra prefix at 2x, and worth investigating.
 *
 * ⚠️ On Anthropic the ladder is NOT monotonic in cost: SuperMax (fable-5) can settle BELOW Premium
 * (opus-5), because Anthropic prices Opus 5 above the fable-5 row. The rungs order CAPABILITY, not
 * price. A cheaper SuperMax row is not a bug.
 */
import fs from 'node:fs';
import path from 'node:path';

const DIR = '.data/generations';

if (!fs.existsSync(DIR)) {
  console.log(`No ${DIR} — run a generation first.`);
  process.exit(0);
}

/** `gen_*` only: `med_*` rows are §4.16 media tasks and have no prompt/cache shape to compare. */
const files = fs
  .readdirSync(DIR)
  .filter((f) => f.startsWith('gen_') && f.endsWith('.json'))
  .map((f) => path.join(DIR, f));

if (files.length === 0) {
  console.log('No generations recorded yet.');
  process.exit(0);
}

const rows = files
  .map((f) => JSON.parse(fs.readFileSync(f, 'utf8')))
  .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));

const n = (v) => (typeof v === 'number' ? v : 0);
const pad = (v, w) => String(v).padStart(w);
const padr = (v, w) => String(v).slice(0, w).padEnd(w);

console.log('');
console.log(
  padr('when', 8) +
    ' ' +
    padr('model', 18) +
    ' ' +
    padr('kind', 9) +
    ' ' +
    pad('in', 7) +
    ' ' +
    pad('cRead', 8) +
    ' ' +
    pad('cWrite', 8) +
    ' ' +
    pad('out', 7) +
    ' ' +
    pad('rawUSD', 8) +
    ' ' +
    pad('credits', 8) +
    ' ' +
    pad('sec', 5) +
    ' ' +
    pad('tr', 3) +
    ' ' +
    'finish',
);

for (const g of rows) {
  const when = String(g.createdAt ?? '').slice(11, 19);
  console.log(
    padr(when, 8) +
      ' ' +
      padr(g.model ?? '?', 18) +
      ' ' +
      padr(g.kind ?? '-', 9) +
      ' ' +
      pad(n(g.promptTokens), 7) +
      ' ' +
      pad(n(g.cacheReadTokens), 8) +
      ' ' +
      pad(n(g.cacheCreationTokens), 8) +
      ' ' +
      pad(n(g.completionTokens), 7) +
      ' ' +
      pad(n(g.rawCostUsd).toFixed(4), 8) +
      ' ' +
      pad(n(g.creditsCharged), 8) +
      ' ' +
      pad(Math.round(n(g.durationMs) / 1000), 5) +
      ' ' +
      pad(n(g.toolRounds), 3) +
      ' ' +
      (g.finishReason ?? '-'),
  );
}

/** Per-model totals — the row that actually answers "which model costs what". */
const byModel = new Map();

for (const g of rows) {
  const key = g.model ?? '?';
  const acc = byModel.get(key) ?? { runs: 0, raw: 0, credits: 0, out: 0, write: 0, read: 0, sec: 0 };

  acc.runs += 1;
  acc.raw += n(g.rawCostUsd);
  acc.credits += n(g.creditsCharged);
  acc.out += n(g.completionTokens);
  acc.write += n(g.cacheCreationTokens);
  acc.read += n(g.cacheReadTokens);
  acc.sec += n(g.durationMs) / 1000;
  byModel.set(key, acc);
}

console.log('');
console.log('per model — averages');
console.log(
  padr('model', 18) + ' ' + pad('runs', 5) + ' ' + pad('rawUSD', 9) + ' ' + pad('credits', 8) + ' ' + pad('out', 8) + ' ' + pad('sec', 6),
);

for (const [model, a] of [...byModel].sort((x, y) => x[0].localeCompare(y[0]))) {
  console.log(
    padr(model, 18) +
      ' ' +
      pad(a.runs, 5) +
      ' ' +
      pad((a.raw / a.runs).toFixed(4), 9) +
      ' ' +
      pad(Math.round(a.credits / a.runs), 8) +
      ' ' +
      pad(Math.round(a.out / a.runs), 8) +
      ' ' +
      pad(Math.round(a.sec / a.runs), 6),
  );
}

console.log('');
console.log('cWrite bills at 2x input, cRead at 0.1x, out at 5x. A first run per model is a cold write.');
console.log('credits deliberately prices cache writes at the READ rate (Phase 1) — the platform absorbs the cold start.');
console.log('');
