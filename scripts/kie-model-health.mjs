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

/**
 * WHICH PROVIDER — `PROBE_PROVIDER=KIE|Comet` (default KIE), matching `cache-probe.mjs`.
 *
 * 🔴 This script is the CATALOGUE prober — the thing that answers FR4's "will this vendor serve this
 * id RIGHT NOW", which no pricing feed can. It was hardcoded to KIE, so when Comet arrived the one
 * instrument that could have caught a dead id could not be pointed at it. It immediately paid for
 * itself: `claude-haiku-4-5` is listed in the spec as live-probed on Comet and actually returns a
 * hard 400 there ("has not been priced by the administrator yet"), while Comet serves the DATED
 * `claude-haiku-4-5-20251001` instead.
 *
 * ⚠️ A feed row is NOT a probe, in either direction: `grok-4.5` appears in Comet's feed under the
 * display code `grok-4-5`, and `claude-haiku-4-5` appears in neither the feed nor the API. Only a
 * request that returns 200 is evidence.
 */
const PROVIDER = (process.env.PROBE_PROVIDER || env.LLM_PROVIDER || 'KIE').toLowerCase();
const IS_COMET = PROVIDER === 'cometapi' || PROVIDER === 'comet';

const KEY = IS_COMET ? env.COMET_API_KEY : env.KIE_API_KEY;

if (!KEY) {
  throw new Error(`no ${IS_COMET ? 'COMET_API_KEY' : 'KIE_API_KEY'} in .env.local`);
}

/*
 * Comet serves every family from ONE origin (unlike KIE's three separately-hosted adapters), and
 * its OpenAI surface is chat-completions rather than Responses — Comet marks `gpt-5*` as `openai` and
 * only `o3-pro` carries `openai-response`. Mirrors `comet-wire.ts`'s `COMET_WIRES`.
 */
const COMET_BASE = env.COMET_BASE_URL || 'https://api.cometapi.com/v1';

const CLAUDE_BASE = IS_COMET ? COMET_BASE : env.KIE_BASE_URL || 'https://api.kie.ai/claude/v1';
const CODEX_BASE = IS_COMET ? COMET_BASE : env.KIE_CODEX_BASE_URL || 'https://api.kie.ai/codex/v1';
const GEMINI_BASE = IS_COMET ? `${COMET_BASE}beta` : env.KIE_GEMINI_BASE_URL || 'https://api.kie.ai/gemini/v1';

/**
 * The family a model id belongs to — the same prefix rule as `app/lib/modules/llm/model-families.ts`.
 * Duplicated rather than imported because this is a plain `.mjs` script with no TS pipeline; keep the
 * two in step. A probe that guessed the wrong wire would report a healthy model as dead.
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

  /* The `chat` family (FR3) — OpenAI-dialect vendors that are not OpenAI. Rides chat-completions. */
  if (/^(grok-|kimi-|qwen|glm-|deepseek|minimax-)/.test(model)) {
    return 'chat';
  }

  throw new Error(`unknown family for "${model}" — add its prefix here and in model-families.ts`);
}
const ROUNDS = Number(process.argv[2] ?? 6);

/**
 * Every model the baked price list carries, ACROSS ALL THREE FAMILIES — keep in step with
 * `baked-market-prices.ts`. A model priced but never probed is a model nobody has checked the
 * provider will serve, and FR9 (the verified-ids rule) says such a model does not ship.
 *
 * ## The 2026-08-04 run (2 rounds x 13 models), which is why the non-Claude families exist
 *
 * `gpt-5-6-sol` 2/2 and `gpt-5-6-luna` 2/2 with ZERO failures; `gemini-3-5-flash` 1 ok / 1 timeout.
 * Meanwhile the CLAUDE catalogue was failing 25–100% with `Server exception, please try again later`
 * — including `claude-sonnet-5`, the platform default, at **0/4**. Same key, same minute, same script:
 * that is what makes it a vendor incident on one adapter rather than a fault in the request shape.
 *
 * `gpt-5-6-terra` was added to the list on the strength of its own probe that day (HTTP 200,
 * streamed, usage captured). Keep this array in step with `KIE_MODELS` + `baked-market-prices.ts`:
 * a shipped id missing here is an id nobody re-checks.
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

  /* The GPT family — OpenAI Responses wire. */
  'gpt-5-6-sol',
  'gpt-5-6-luna',

  'gpt-5-6-terra', // PROBED CLEAN 2026-08-04 (HTTP 200, streamed, usage captured) — ships.

  /* The Gemini family — native wire. */
  'gemini-3-5-flash',
];

/**
 * Comet's candidate catalogue — a DIFFERENT list, because the two vendors do not serve the same ids.
 *
 * 🔴 `claude-haiku-4-5` is deliberately here so the probe keeps reporting its 400. It is listed in
 * `_specs/cometapi-provider_spec.md` as verified and it is not: Comet answers
 * `"model claude-haiku-4-5 has not been priced by the administrator yet"` and serves the DATED
 * `claude-haiku-4-5-20251001` instead, at an output cap its feed reports as 8K rather than 64K.
 * Keeping the dead id in the probe list is how that stays visible instead of becoming folklore.
 */
const COMET_MODELS_TO_PROBE = [
  'claude-sonnet-5',
  'claude-opus-5',
  'claude-opus-4-8',
  'claude-fable-5',

  'claude-haiku-4-5', // EXPECTED 400 — see above. Its dated twin is the id Comet actually serves.
  'claude-haiku-4-5-20251001',

  /* The `chat` family (FR3) — all four probed 200 on 2026-08-10. */
  'grok-4.5',
  'kimi-k3',
  'qwen3-coder',
  'glm-5.2',
];

/** Which catalogue this run probes. */
const PROBE_LIST = IS_COMET ? COMET_MODELS_TO_PROBE : MODELS;

/**
 * The endpoint and body for one probe, derived from the model's FAMILY.
 *
 * Each family speaks a different protocol, so "is this model serveable?" cannot be asked with one
 * request shape. `thinkingFlag` is KIE-proprietary and Claude-only (`kie-wire.ts`); the other two
 * families get their own minimal reasoning field so the probe exercises the same shape the platform
 * actually sends.
 */
function probeRequest(model, thinkingFlag) {
  const family = familyOf(model);

  /*
   * 🔴 The family names a DIALECT; the PROVIDER chooses the WIRE (FR2). `gpt-*` is OpenAI-dialect on
   * both gateways but rides **Responses** on KIE and **chat-completions** on Comet, so a probe that
   * assumed one endpoint would report every gpt id dead on the other provider. The `chat` family has
   * no Responses form anywhere.
   */
  if (family === 'chat' || (family === 'codex' && IS_COMET)) {
    return {
      url: `${CODEX_BASE}/chat/completions`,
      body: { model, max_tokens: 1, messages: [{ role: 'user', content: 'ok' }], stream: true },
    };
  }

  if (family === 'codex') {
    return {
      url: `${CODEX_BASE}/responses`,
      body: {
        model,
        input: [{ role: 'user', content: 'ok' }],
        max_output_tokens: 16,
        reasoning: { effort: 'low' },
        stream: true,
      },
    };
  }

  if (family === 'gemini') {
    return {
      url: `${GEMINI_BASE}/models/${model}:streamGenerateContent?alt=sse`,
      body: {
        contents: [{ role: 'user', parts: [{ text: 'ok' }] }],
        generationConfig: {
          maxOutputTokens: 16,
          thinkingConfig: { includeThoughts: true, thinkingLevel: 'low' },
        },
      },
    };
  }

  const body = { model, max_tokens: 1, messages: [{ role: 'user', content: 'ok' }], stream: true };

  /* `thinkingFlag` is KIE's private Claude-adapter field. Sending it to Comet would probe a shape the platform never sends. */
  if (thinkingFlag && !IS_COMET) {
    body.thinkingFlag = true;
  }

  return { url: `${CLAUDE_BASE}/messages`, body };
}

async function attempt(model, thinkingFlag) {
  /* `thinkingFlag` is Claude-only, so the two passes are identical elsewhere — probe once. */
  if (thinkingFlag && (IS_COMET || familyOf(model) !== 'claude')) {
    return { skip: true };
  }

  const { url, body } = probeRequest(model, thinkingFlag);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${KEY}`,
        ...(familyOf(model) === 'claude' ? { 'anthropic-version': '2023-06-01' } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });

    if (response.ok) {
      /*
       * A 200 is not enough: KIE returns one and then streams an error event on some failures. Read
       * the body so a model that accepts the request and cannot answer is not counted healthy.
       */
      const text = await response.text();
      const streamError = text.match(/"error"\s*:\s*\{[^}]*"message"\s*:\s*"([^"]+)"/);

      if (streamError) {
        return { ok: false, note: `200-then-error: ${streamError[1]}`.slice(0, 90) };
      }

      return { ok: true, sample: text.slice(0, 400) };
    }

    const text = await response.text();

    return {
      ok: false,
      note: `${response.status} ${(text.match(/"message":"([^"]+)"/) ?? [])[1] ?? text.slice(0, 90)}`.trim(),
    };
  } catch (error) {
    return { ok: false, note: String(error?.message ?? error).slice(0, 60) };
  }
}

console.log(
  `${IS_COMET ? 'Comet' : 'KIE'} catalogue health — ${ROUNDS} rounds x ${PROBE_LIST.length} models` +
    `${IS_COMET ? '' : ' x thinkingFlag on/off'}\n`,
);

const tally = Object.fromEntries(PROBE_LIST.map((m) => [m, { ok: 0, fail: 0, notes: new Set() }]));

for (let round = 0; round < ROUNDS; round++) {
  const shift = round % PROBE_LIST.length;
  const order = PROBE_LIST.slice(shift).concat(PROBE_LIST.slice(0, shift));
  const marks = [];

  for (const model of order) {
    let roundOk = 0;

    for (const flag of [true, false]) {
      const result = await attempt(model, flag);

      /* Non-Claude families have no `thinkingFlag`, so their two passes would be identical. */
      if (result.skip) {
        roundOk++;
        continue;
      }

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

for (const model of PROBE_LIST) {
  const { ok, fail, notes } = tally[model];
  const rate = `${((fail / Math.max(1, ok + fail)) * 100).toFixed(0)}%`;
  console.log(
    `  ${model.padEnd(20)} ${String(ok).padStart(3)}  ${String(fail).padStart(5)}   ${rate.padStart(6)}     ${[...notes].join(' | ')}`,
  );
}

const dead = PROBE_LIST.filter((m) => tally[m].ok === 0);
const healthy = PROBE_LIST.filter((m) => tally[m].fail === 0);

console.log(`\n  healthy (0 failures): ${healthy.join(', ') || 'NONE'}`);
console.log(`  unserveable (0 successes): ${dead.join(', ') || 'none'}`);
console.log(
  '\n  A model here is only usable if it is ALSO priced (baked-market-prices.ts) and LISTED (kie-wire.ts).',
);
