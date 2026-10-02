/*
 * Managed Agents spike (T1, _specs/managed-agents-engine_plan.md).
 * Runs the owner's prompt on a Managed Agents session whose project tools execute against a local copy
 * of the pinned starter (standing in for the browser's Nodepod sandbox), and records time, cost and
 * outcome. Usage: node spike.mjs --model claude-opus-5-5 --effort medium --run 1 [--budget 20]
 *
 * ⚠️ Kept as the T1 record and the starting point for T11's eval harness. It ran OUTSIDE the repo
 * (its own folder with `@anthropic-ai/sdk` + `dotenv` installed, beside a `starter/` folder extracted
 * from the pinned AppTemplate snapshot and `npm install`ed), so the SPIKE/STARTER/AGENT_REF paths
 * below are that layout's. T11's eval harness (both engines, through the real route) is
 * `scripts/engine-eval.mjs`.
 */
import Anthropic, { toFile } from '@anthropic-ai/sdk';
import dotenv from 'dotenv';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SPIKE = path.resolve(HERE, '..');
const REPO = '/Users/mackey/Documents/Repos/Babylon/Repositories/AgentWorkspace';
const AGENT_REF = '/Users/mackey/Documents/Repos/Babylon/Repositories/AgentReference';
const STARTER = path.join(SPIKE, 'starter');
const STATE_FILE = path.join(HERE, 'state.json');
const RESULTS_FILE = path.join(SPIKE, 'results.jsonl');

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
const MODEL = args.model ?? 'claude-opus-5-5';
const EFFORT = args.effort ?? 'medium';
const RUN = args.run ?? '1';
const BUDGET_USD = Number(args.budget ?? 20);
const MAX_MINUTES = Number(args.minutes ?? 45);
const PROMPT =
  args.prompt ??
  'Make me a mario kart racer clone complete with drifting mechanics with sound fx. Use the WebAudio API directly';

const apiKey = dotenv.parse(fs.readFileSync(path.join(REPO, '.env.local'))).ANTHROPIC_API_KEY;

if (!apiKey) {
  throw new Error('ANTHROPIC_API_KEY missing from .env.local');
}

const client = new Anthropic({ apiKey });

const PRICES = {
  'claude-opus-5-5': { in: 4, out: 20, read: 0.2, write: 5 },
  'claude-sonnet-5-5': { in: 2, out: 10, read: 0.2, write: 2.5 },
};

const state = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : {};
const saveState = () => fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
const t0 = Date.now();
const elapsed = () => ((Date.now() - t0) / 1000).toFixed(1);
const log = (...m) => console.log(`[${elapsed()}s]`, ...m);

// ─── the project (stands in for the browser's Nodepod sandbox) ──────────────────────────────────

const PROJECT = path.join(SPIKE, 'runs', `${MODEL.replace('claude-', '')}-${EFFORT}-${RUN}`);
fs.rmSync(PROJECT, { recursive: true, force: true });
fs.mkdirSync(PROJECT, { recursive: true });
fs.cpSync(STARTER, PROJECT, { recursive: true, filter: (src) => !src.includes(`${path.sep}node_modules`) });
fs.symlinkSync(path.join(STARTER, 'node_modules'), path.join(PROJECT, 'node_modules'), 'dir');

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git']);
const READ_ONLY = [/^src\/babylon\//, /^src\/routing\//, /^src\/app\.tsx$/];

function resolveProjectPath(p) {
  const rel = path.posix.normalize(String(p ?? '').replace(/^\.?\/+/, ''));

  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Invalid project path: ${p}`);
  }

  return { rel, abs: path.join(PROJECT, rel) };
}

function walk(dir, base = '') {
  const out = [];

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) {
      continue;
    }

    const rel = base ? `${base}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      out.push(...walk(path.join(dir, entry.name), rel));
    } else {
      out.push(rel);
    }
  }

  return out;
}

const stats = { tools: {}, firstWriteAt: null, writes: new Set(), checks: [] };

async function checkGame() {
  const errors = [];

  try {
    await run('npx', ['tsc', '-b', '--force'], { cwd: PROJECT, timeout: 180_000, maxBuffer: 20e6 });
  } catch (e) {
    const out = `${e.stdout ?? ''}${e.stderr ?? ''}`.trim();
    errors.push(`TypeScript:\n${out.split('\n').slice(0, 60).join('\n')}`);
  }

  if (errors.length === 0) {
    try {
      await run('npx', ['vite', 'build', '--logLevel', 'error'], { cwd: PROJECT, timeout: 240_000, maxBuffer: 20e6 });
    } catch (e) {
      const out = `${e.stdout ?? ''}${e.stderr ?? ''}`.trim();
      errors.push(`Vite build:\n${out.split('\n').slice(-60).join('\n')}`);
    }
  }

  const ok = errors.length === 0;
  stats.checks.push({ at: Number(elapsed()), ok });

  return ok ? 'ok: TypeScript and the production build both pass.' : `FAILED\n${errors.join('\n\n')}`;
}

const TOOL_IMPLS = {
  async project_list({ path: dir }) {
    const root = dir ? resolveProjectPath(dir).abs : PROJECT;
    const files = walk(root, dir ? resolveProjectPath(dir).rel : '');

    return files.slice(0, 800).join('\n') + (files.length > 800 ? `\n… ${files.length - 800} more` : '');
  },
  async project_read({ path: p, offset, limit }) {
    const { abs } = resolveProjectPath(p);
    const lines = fs.readFileSync(abs, 'utf8').split('\n');
    const start = Math.max(0, Number(offset ?? 1) - 1);
    const end = limit ? start + Number(limit) : lines.length;
    const body = lines
      .slice(start, end)
      .map((l, i) => `${String(start + i + 1).padStart(5)}\t${l}`)
      .join('\n');

    return body.length > 90_000 ? `${body.slice(0, 90_000)}\n… truncated; read with offset/limit` : body;
  },
  async project_write({ path: p, content }) {
    const { rel, abs } = resolveProjectPath(p);

    if (READ_ONLY.some((r) => r.test(rel))) {
      return `Refused: ${rel} is read-only.`;
    }

    if (typeof content !== 'string') {
      return 'Refused: content must be a string.';
    }

    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    stats.firstWriteAt ??= Number(elapsed());
    stats.writes.add(rel);

    return `Wrote ${rel} (${content.split('\n').length} lines).`;
  },
  async project_edit({ path: p, old_string, new_string, replace_all }) {
    const { rel, abs } = resolveProjectPath(p);

    if (READ_ONLY.some((r) => r.test(rel))) {
      return `Refused: ${rel} is read-only.`;
    }

    const text = fs.readFileSync(abs, 'utf8');
    const count = text.split(old_string).length - 1;

    if (count === 0) {
      return 'Error: old_string not found. Re-read the file and match it exactly.';
    }

    if (count > 1 && !replace_all) {
      return `Error: old_string occurs ${count} times. Add context or set replace_all.`;
    }

    fs.writeFileSync(abs, replace_all ? text.split(old_string).join(new_string) : text.replace(old_string, new_string));
    stats.firstWriteAt ??= Number(elapsed());
    stats.writes.add(rel);

    return `Edited ${rel}.`;
  },
  async project_grep({ pattern, path: dir }) {
    const re = new RegExp(pattern);
    const base = dir ? resolveProjectPath(dir).rel : '';
    const hits = [];

    for (const rel of walk(dir ? resolveProjectPath(dir).abs : PROJECT, base)) {
      if (/\.(png|jpg|ico|wasm|glb|gz)$/i.test(rel)) {
        continue;
      }

      const lines = fs.readFileSync(path.join(PROJECT, rel), 'utf8').split('\n');
      lines.forEach((l, i) => re.test(l) && hits.push(`${rel}:${i + 1}: ${l.slice(0, 200)}`));

      if (hits.length > 200) {
        break;
      }
    }

    return hits.length ? hits.slice(0, 200).join('\n') : 'No matches.';
  },
  async project_run({ command }) {
    const m = /^npm install( [@\w./-]+)+$/.exec(String(command ?? '').trim());

    if (!m) {
      return 'Refused. Allowed: `npm install <package>`. The dev server is already running.';
    }

    return 'Refused in this environment: dependencies are fixed for this run. Use what the starter provides.';
  },
  async check_game() {
    return checkGame();
  },
  async update_todos({ items }) {
    return `Todo list updated (${Array.isArray(items) ? items.length : 0} items).`;
  },
};

const s = (props, required = []) => ({ type: 'object', properties: props, required });
const CUSTOM_TOOLS = [
  [
    'project_list',
    "List the files in the user's game project (relative paths). Optionally pass a sub-directory.",
    s({ path: { type: 'string' } }),
  ],
  [
    'project_read',
    "Read a file from the user's game project. Returns numbered lines. Use offset/limit for long files.",
    s({ path: { type: 'string' }, offset: { type: 'integer' }, limit: { type: 'integer' } }, ['path']),
  ],
  [
    'project_write',
    "Create or overwrite a file in the user's game project with the full content.",
    s({ path: { type: 'string' }, content: { type: 'string' } }, ['path', 'content']),
  ],
  [
    'project_edit',
    'Replace an exact string in a project file. old_string must match exactly and be unique unless replace_all is true.',
    s(
      {
        path: { type: 'string' },
        old_string: { type: 'string' },
        new_string: { type: 'string' },
        replace_all: { type: 'boolean' },
      },
      ['path', 'old_string', 'new_string'],
    ),
  ],
  [
    'project_grep',
    "Search the user's game project with a JavaScript regular expression. Returns file:line matches.",
    s({ pattern: { type: 'string' }, path: { type: 'string' } }, ['pattern']),
  ],
  [
    'project_run',
    'Run an allow-listed command in the project. Only `npm install <package>` is allowed; the dev server is already running.',
    s({ command: { type: 'string' } }, ['command']),
  ],
  [
    'check_game',
    'Verify the project: runs the TypeScript typecheck and the production build. Call after writing code and fix every error until it reports ok.',
    s({}),
  ],
  [
    'update_todos',
    'Replace your visible todo list for this task. Each item has text and done.',
    s(
      {
        items: {
          type: 'array',
          items: { type: 'object', properties: { text: { type: 'string' }, done: { type: 'boolean' } } },
        },
      },
      ['items'],
    ),
  ],
].map(([name, description, input_schema]) => ({ type: 'custom', name, description, input_schema }));

const SYSTEM = `You are the game-building agent of the Babylon Toolkit App Builder. You build BabylonJS + Babylon Toolkit web games inside a Vite + React + TypeScript starter project.

There are two filesystems:
- The user's PROJECT, reachable ONLY through the project_* tools and check_game. Paths are relative to the project root (e.g. src/pages/Home.tsx).
- The Babylon Toolkit Agent Reference: read-only docs mounted under /workspace/agent, read with read/glob/grep. Start at /workspace/agent/reference.md, which indexes the rest, and treat it as the source of truth for Toolkit conventions and APIs. Confirm exact API names in /workspace/agent/training/declarations/babylon.toolkit.d.ts before using them (grep it; never read it whole).

Project rules (never break):
- Game code (GameModes and script components) lives in src/scripts/. src/babylon/classes/** is a read-only example library: copy from it into src/scripts/, never edit it, and rebase relative imports when copying ('../globals' becomes '../babylon/globals'). src/babylon/system/**, src/routing/** and src/app.tsx are read-only.
- Gameplay starts ONLY via navigate('/play', { gameMode: '<RegisteredGameModeClass>', sceneUrl?, ...extra }) from useUnifiedNavigation (src/babylon/system/platform). React UI in src/pages and src/components must never import Babylon modules or GameManager.
- Replace the landing page (src/pages/Home.tsx and Home.css) with one designed for this game; nothing of the starter page survives. src/chrome/** (splash, preloader, overlay) may be restyled.
- Never delete files under public/.
- project_run only allows \`npm install <package>\`; the dev server is already running.

Work the way you would in Claude Code: read what you need, keep a short todo list with update_todos, write the code, then run check_game and fix every error until it reports ok. Finish with a two or three sentence summary for the user.`;

// ─── one-time setup: reference files, environment, agent ─────────────────────────────────────────

async function uploadReference() {
  if (state.referenceFiles) {
    return state.referenceFiles;
  }

  const files = [];
  const add = (rel) => files.push(rel);
  add('reference.md');

  for (const dir of ['references', 'training']) {
    const walkRef = (d, base) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.name.startsWith('.')) {
          continue;
        }

        const rel = `${base}/${e.name}`;

        if (e.isDirectory()) {
          walkRef(path.join(d, e.name), rel);
        } else {
          add(rel);
        }
      }
    };
    walkRef(path.join(AGENT_REF, dir), dir);
  }

  const uploaded = [];

  for (const rel of files) {
    const f = await client.beta.files.upload({
      file: await toFile(fs.createReadStream(path.join(AGENT_REF, rel)), path.basename(rel)),
    });
    uploaded.push({ rel, id: f.id });
  }
  state.referenceFiles = uploaded;
  saveState();
  log(`uploaded ${uploaded.length} reference files`);

  return uploaded;
}

async function ensureEnvironment() {
  if (state.environmentId) {
    return state.environmentId;
  }

  const env = await client.beta.environments.create({
    name: 'btk-spike-env',
    config: { type: 'cloud', networking: { type: 'limited', allowed_hosts: ['api.anthropic.com'] } },
  });
  state.environmentId = env.id;
  saveState();

  return env.id;
}

async function ensureAgent() {
  const key = `agent:${MODEL}:${EFFORT}`;

  if (state[key]) {
    return state[key];
  }

  const agent = await client.beta.agents.create({
    name: `btk-spike-${MODEL}-${EFFORT}`,
    model: { id: MODEL, effort: EFFORT },
    system: SYSTEM,
    tools: [
      {
        type: 'agent_toolset_20260401',
        default_config: { enabled: false },
        configs: [
          { name: 'read', enabled: true },
          { name: 'glob', enabled: true },
          { name: 'grep', enabled: true },
        ],
      },
      ...CUSTOM_TOOLS,
    ],
  });
  state[key] = { id: agent.id, version: agent.version };
  saveState();

  return state[key];
}

// ─── the session ─────────────────────────────────────────────────────────────────────────────────

const usage = { input: 0, output: 0, read: 0, write: 0, requests: 0 };
const timeline = [];

async function main() {
  const refs = await uploadReference();
  const environmentId = await ensureEnvironment();
  const agent = await ensureAgent();

  const session = await client.beta.sessions.create({
    agent: { type: 'agent', id: agent.id, version: agent.version },
    environment_id: environmentId,
    title: `spike ${MODEL} ${EFFORT} #${RUN}`,
    budget: { type: 'limit', max_list_cost: { amount: String(Math.round(BUDGET_USD * 100)), currency: 'USD' } },
    resources: refs.map((r) => ({ type: 'file', file_id: r.id, mount_path: `/workspace/agent/${r.rel}` })),
  });
  log(`session ${session.id}`);
  log(`trace: https://platform.claude.com/workspaces/default/sessions/${session.id}`);

  const seen = new Set();
  const answered = new Set();
  let finished = null;
  const deadline = t0 + MAX_MINUTES * 60_000;

  async function answer(event) {
    if (answered.has(event.id)) {
      return;
    }

    answered.add(event.id);
    stats.tools[event.name] = (stats.tools[event.name] ?? 0) + 1;

    const started = Date.now();
    let text;

    try {
      const impl = TOOL_IMPLS[event.name];
      text = impl ? await impl(event.input ?? {}) : `Unknown tool ${event.name}`;
    } catch (e) {
      text = `Error: ${e.message}`;
    }
    timeline.push({ at: Number(elapsed()), tool: event.name, ms: Date.now() - started, path: event.input?.path });
    log(
      `  ${event.name}${event.input?.path ? ` ${event.input.path}` : ''} (${Date.now() - started}ms)${event.name === 'check_game' ? ` → ${text.split('\n')[0]}` : ''}`,
    );
    await client.beta.sessions.events.send(session.id, {
      events: [
        {
          type: 'user.custom_tool_result',
          custom_tool_use_id: event.id,
          content: [{ type: 'text', text: String(text) }],
        },
      ],
    });
  }

  function handle(event) {
    if (event.id && seen.has(event.id)) {
      return;
    }

    if (event.id) {
      seen.add(event.id);
    }

    switch (event.type) {
      case 'agent.message':
        for (const b of event.content ?? []) {
          if (b.type === 'text' && b.text.trim()) {
            log(`💬 ${b.text.trim().slice(0, 300)}`);
          }
        }
        break;
      case 'agent.tool_use':
        log(`  [ref] ${event.name} ${JSON.stringify(event.input).slice(0, 120)}`);
        break;
      case 'agent.custom_tool_use':
        void answer(event);
        break;
      case 'span.model_request_end': {
        const u = event.model_usage ?? {};
        usage.input += u.input_tokens ?? 0;
        usage.output += u.output_tokens ?? 0;
        usage.read += u.cache_read_input_tokens ?? 0;
        usage.write += u.cache_creation_input_tokens ?? 0;
        usage.requests += 1;

        if (event.is_error) {
          log('⚠️ model request error');
        }

        break;
      }
      case 'agent.thread_context_compacted':
        log('🗜  context compacted');
        break;
      case 'session.error':
        log(`❌ session.error ${JSON.stringify(event).slice(0, 400)}`);
        break;
      case 'session.status_idle': {
        const reason = event.stop_reason?.type;

        if (reason === 'end_turn' || reason === 'budget_reached') {
          finished = reason;
        }

        break;
      }
      case 'session.status_terminated':
        finished = 'terminated';
        break;
      default:
    }
  }

  let first = true;

  while (!finished) {
    if (Date.now() > deadline) {
      log('⏱  time cap reached — interrupting');
      await client.beta.sessions.events.send(session.id, { events: [{ type: 'user.interrupt' }] });
      finished = 'time_cap';
      break;
    }

    try {
      const stream = await client.beta.sessions.events.stream(session.id);

      if (first) {
        first = false;
        await client.beta.sessions.events.send(session.id, {
          events: [{ type: 'user.message', content: [{ type: 'text', text: PROMPT }] }],
        });
      } else {
        // Reconnect: catch up on anything emitted while the stream was down.
        for await (const ev of client.beta.sessions.events.list(session.id)) {
          handle(ev);
        }
      }

      for await (const ev of stream) {
        handle(ev);

        if (finished || Date.now() > deadline) {
          break;
        }
      }
    } catch (e) {
      log(`stream dropped: ${e.message} — reconnecting`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  const final = await client.beta.sessions.retrieve(session.id);
  const price = PRICES[MODEL];
  const estimate =
    (usage.input * price.in + usage.output * price.out + usage.read * price.read + usage.write * price.write) / 1e6;
  const finalCheck = await checkGame();
  const result = {
    model: MODEL,
    effort: EFFORT,
    run: RUN,
    session: session.id,
    finished,
    minutes: Number((Number(elapsed()) / 60).toFixed(1)),
    firstWriteMinutes: stats.firstWriteAt ? Number((stats.firstWriteAt / 60).toFixed(1)) : null,
    listCost: final.usage?.list_cost ?? null,
    activeSeconds: final.usage?.active_seconds ?? null,
    tokenEstimateUsd: Number(estimate.toFixed(2)),
    usage,
    tools: stats.tools,
    filesWritten: [...stats.writes],
    checks: stats.checks,
    finalCheckOk: finalCheck.startsWith('ok'),
    project: PROJECT,
  };
  fs.appendFileSync(RESULTS_FILE, `${JSON.stringify(result)}\n`);
  fs.writeFileSync(path.join(PROJECT, '.spike-timeline.json'), JSON.stringify(timeline, null, 2));
  log('RESULT', JSON.stringify(result, null, 2));
}

main().catch((e) => {
  console.error('FATAL', e?.status ?? '', e?.message ?? e, e?.error ? JSON.stringify(e.error) : '');
  process.exit(1);
});
