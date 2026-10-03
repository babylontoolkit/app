/**
 * Managed Agents effort probe (`node scripts/effort-probe.mjs`).
 *
 * Answers the question `_specs/effort-selector_plan.md` T1 / D5 needs before a user may pick an effort:
 * does each rung model accept a PER-SESSION effort override at `xhigh` and `max`? The SDK says of
 * `xhigh` only "Not all models accept this level", so the answer is measured, never assumed.
 *
 * For every rung model (`LLM_MODEL`, `PREMIUM_MODEL`, `PLATINUM_MODEL` from `.env.local`) and every level
 * in [`high` (control), `xhigh`, `max`] it:
 *   1. creates a session exactly as `app/lib/.server/agent-managed/engine.ts` does, but with
 *      `agent: { type: 'agent_with_overrides', id, version, model: { id, effort } }`;
 *   2. reads back `session.agent.model.id` / `.effort` (creation + matching read-back = accepted);
 *   3. creates it WITH a budget (as the engine's `budgetFor(0)` does — a session created without one can
 *      never gain one, a 400) and then raises it with `sessions.update(id, { budget })`, the engine's
 *      per-turn budget call, to prove an overrides session still takes it (amount is a STRING of cents, as
 *      `budgetAmountCents` returns — a number is a 400);
 *   4. archives the session, as the engine does when it discards one.
 *
 * No message is sent — creation acceptance is the signal, and a message would bill a turn per cell.
 * Agent ids come from the local prompt store's `managedAgents` records (the newest prompt version that
 * has them); a rung with no record overrides `model.id` on another rung's agent.
 *
 * The API key is read from `.env.local` and NEVER printed.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';

const envText = readFileSync(new URL('../.env.local', import.meta.url), 'utf-8');
const env = Object.fromEntries(
  envText
    .split('\n')
    .filter((l) => l.trim() && !l.trim().startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=');
      return [
        l.slice(0, i).trim(),
        l
          .slice(i + 1)
          .replace(/\s+#.*$/, '')
          .trim()
          .replace(/^["']|["']$/g, ''),
      ];
    }),
);

if (!env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY is not set in .env.local — cannot probe.');
  process.exit(1);
}

const rungs = [
  ['standard', env.LLM_MODEL || 'claude-sonnet-5-5'],
  ['premium', env.PREMIUM_MODEL],
  ['platinum', env.PLATINUM_MODEL],
].filter(([, model]) => model);

const LEVELS = ['high', 'xhigh', 'max'];

/** The newest local prompt version carrying `managedAgents` records. */
function loadAgentRecords() {
  const dir = new URL('../.data/storage/prompt/versions/', import.meta.url);
  let files;

  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return {};
  }

  const sorted = files.map((f) => ({ f, mtime: statSync(new URL(f, dir)).mtimeMs })).sort((a, b) => b.mtime - a.mtime);

  for (const { f } of sorted) {
    try {
      const doc = JSON.parse(readFileSync(new URL(f, dir), 'utf-8'));

      if (doc.managedAgents && Object.keys(doc.managedAgents).length) {
        return doc.managedAgents;
      }
    } catch {
      /* skip unreadable */
    }
  }

  return {};
}

const records = Object.values(loadAgentRecords());

if (!records.length) {
  console.error('No provisioned managed agent record in .data/storage/prompt — press Provision first.');
  process.exit(1);
}

const recordFor = (model) => records.find((r) => r.model === model) ?? records[0];

/** `effort` may come back as a bare string or `{ type }`. */
const effortOf = (value) => (value && typeof value === 'object' ? value.type : value) ?? null;
const errText = (error) => {
  const status = error?.status ? `${error.status} ` : '';
  const msg = error?.error?.error?.message ?? error?.message ?? String(error);

  return `${status}${msg}`.replace(/\s+/g, ' ').slice(0, 200);
};

const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
const rows = [];

for (const [rung, model] of rungs) {
  const record = recordFor(model);
  const borrowed = record.model !== model;

  for (const level of LEVELS) {
    const row = { rung, model, level, agent: borrowed ? `${record.model} (borrowed)` : 'own' };

    try {
      const session = await client.beta.sessions.create({
        agent: {
          type: 'agent_with_overrides',
          id: record.agentId,
          version: record.agentVersion,
          model: { id: model, effort: level },
        },
        environment_id: record.environmentId,
        title: `effort-probe ${model} ${level}`,

        // The engine attaches a budget AT CREATE (`budgetFor(0)`) — a session with none can never gain one.
        budget: { type: 'limit', max_list_cost: { amount: '100', currency: 'USD' } },
      });

      const readModel = session.agent?.model ?? {};
      row.readId = readModel.id ?? null;
      row.readEffort = effortOf(readModel.effort);
      row.result = row.readEffort === level && row.readId === model ? 'accepted' : 'MISMATCH';

      try {
        await client.beta.sessions.update(session.id, {
          budget: { type: 'limit', max_list_cost: { amount: '150', currency: 'USD' } },
        });
        row.budget = 'ok';
      } catch (error) {
        row.budget = `error: ${errText(error)}`;
      }

      try {
        await client.beta.sessions.archive(session.id);
        row.archived = 'yes';
      } catch (error) {
        row.archived = `error: ${errText(error)}`;
      }
    } catch (error) {
      row.result = `error: ${errText(error)}`;
    }

    rows.push(row);
    console.error(`${model} @ ${level}: ${row.result}`);
  }
}

console.log('\n| rung | model | level | agent | result | read-back id | read-back effort | budget update | archived |');
console.log('|---|---|---|---|---|---|---|---|---|');

for (const r of rows) {
  console.log(
    `| ${r.rung} | ${r.model} | ${r.level} | ${r.agent} | ${r.result} | ${r.readId ?? '—'} | ${r.readEffort ?? '—'} | ${r.budget ?? '—'} | ${r.archived ?? '—'} |`,
  );
}
