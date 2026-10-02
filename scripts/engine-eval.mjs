#!/usr/bin/env node
/*
 * Engine eval harness (managed-agents-engine plan T11) — the evidence for T12's default switch.
 *
 * Runs a fixed prompt set N times per engine against a RUNNING local dev server, through the same door
 * the browser uses (POST /api/agent), and plays the browser's part: every `workspace-tool-call` data part
 * the server streams is executed against a local project directory and answered on
 * POST /api/agent/tool-result. Each run appends one JSON line to the results file; `--report` turns the
 * accumulated lines into a markdown comparison table (success rate, median minutes, median credits).
 * Modelled on Convex Chef's `test-kitchen`.
 *
 *   node scripts/engine-eval.mjs --engines legacy,managed --prompts mario,platformer,edit,fix --n 1
 *   node scripts/engine-eval.mjs --report
 *
 * The server must be a local dev server in LOCAL MODE (no Supabase: the caller is the verified local
 * developer, so no cookie is needed — pass `--cookie` otherwise), started with
 * AGENT_ENGINE_EVAL_OVERRIDE=true so the body's `engineOverride` picks the engine per request
 * (`resolveEngineForRequest`; ignored in production). Runs SPEND REAL CREDITS AND PROVIDER MONEY.
 *
 * What the harness cannot do, by construction: there is no browser, so `check_game` here is
 * `tsc -b --force` + `vite build` (no scene probe, `play: null`), preview tools (evaluate_in_game, …)
 * answer "unavailable", `npm install` is refused (every run shares one installed node_modules), and
 * media renders are counted but never written into the project. Both engines see the same harness.
 */
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  aggregateResults,
  applyStreamPart,
  buildFileMap,
  buildGameCheckResult,
  classifyRunCommand,
  createDataStreamParser,
  engineMismatch,
  formatReport,
  isStrictPass,
  newTurnTally,
  parseArgs,
  parseResultsJsonl,
  resolveInside,
  resolveWorkDir,
} from './engine-eval/lib.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORK_DIR = '/home/project';
const RUN_OUTPUT_TAIL_CHARS = 12_000;

/* ───────────────────────────── the fixed prompt set ───────────────────────────── */

const PROMPTS = {
  mario: {
    title: 'Mario Kart Racer',
    kind: 'first-build',
    text: 'Make me a mario kart racer clone complete with drifting mechanics with sound fx. Use the WebAudio API directly',
  },
  platformer: {
    title: 'Coin Platformer',
    kind: 'first-build',
    text: 'Make me a 3D platformer with a jumping character, moving platforms and collectible coins',
  },
  edit: {
    title: 'Pause Menu Edit',
    kind: 'edit',
    text: 'Add a pause menu to the game that opens with the Escape key',
  },
  fix: {
    title: 'Build Fix',
    kind: 'fix',
    text: null, // composed from the real tsc output after the starter is deliberately broken
  },
};

/*
 * The client's creation plan (`app/lib/agent/creation-plan.ts`): DEFAULT_CREATION_PHASES with their
 * labels, `creationPhaseMessage` ("Step N — label."), and the runner's one auto-continue / one retry
 * (`app/lib/chat/creation-plan-runner.ts`). Mirrored, not imported — this is plain Node, no TS loader.
 */
const PHASES = [
  { id: 'design', label: 'Art direction' },
  { id: 'game', label: 'Game code' },
  { id: 'frontend', label: 'Front end' },
];
const KEEP_BUILDING_MESSAGE =
  'Continue building from where you stopped. Re-read the files you already wrote with read_file, finish the remaining work on your todo list, then run check_game until it passes.';
const MAX_AUTO_CONTINUES = 1;
const MAX_CREATION_PHASE_RETRIES = 1;

const BROKEN_FILE = 'src/pages/Home.tsx';
const BREAKAGE = "\nexport const evalBrokenValue: number = 'this is not a number';\n";

const PREVIEW_UNAVAILABLE = 'The preview is unavailable in the eval harness (there is no browser); use check_game.';

const HELP = `Engine eval harness (managed-agents-engine plan T11)

Usage:
  node scripts/engine-eval.mjs [--engines legacy,managed] [--prompts mario,platformer,edit,fix] [--n 1]
                               [--base http://localhost:5173] [--minutes 45] [--out .data/engine-eval/results.jsonl]
                               [--data-dir .data] [--work-dir <dir outside the repo>] [--cookie "<Cookie header>"]
                               [--refresh-starter]
  node scripts/engine-eval.mjs --report [--out <file>]
  node scripts/engine-eval.mjs --help

Runs each prompt --n times per engine against a running local dev server (start it with
AGENT_ENGINE_EVAL_OVERRIDE=true), appends one JSON line per run to --out, then prints the comparison
table. --report prints the table from --out without running anything. Runs spend real credits.
Run projects, the starter copy and the shared node_modules go to --work-dir (default <tmpdir>/btk-engine-eval),
which must be outside the repo: the dev server watches the repo and reloads its modules on every run's tsconfig.

Prompts: ${Object.keys(PROMPTS).join(', ')}`;

/* ───────────────────────────── small utilities ───────────────────────────── */

function sh(cmd, argv, { cwd, timeout }) {
  return new Promise((resolve) => {
    execFile(
      cmd,
      argv,
      { cwd, timeout, maxBuffer: 50e6, env: { ...process.env, FORCE_COLOR: '0' } },
      (error, stdout, stderr) => {
        const output = `${stdout ?? ''}${stderr ?? ''}`.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '');
        const exitCode = error ? (typeof error.code === 'number' ? error.code : error.killed ? 124 : 1) : 0;

        resolve({ exitCode, output, timedOut: !!error?.killed });
      },
    );
  });
}

const tail = (text, max) => (text.length > max ? text.slice(text.length - max) : text);

function log(...message) {
  console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...message);
}

/* ───────────────────────────── server calls ───────────────────────────── */

function makeApi(base, cookie) {
  const headers = (extra = {}) => ({ ...(cookie ? { Cookie: cookie } : {}), ...extra });

  async function call(method, route, body, signal) {
    const response = await fetch(`${base}${route}`, {
      method,
      headers: headers(body ? { 'Content-Type': 'application/json' } : {}),
      body: body ? JSON.stringify(body) : undefined,
      signal,
    });

    const text = await response.text();
    let payload;

    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }

    if (!response.ok) {
      const message =
        typeof payload === 'object' ? (payload?.message ?? payload?.error) : String(payload).slice(0, 300);
      throw new Error(`${method} ${route} → ${response.status}: ${message}`);
    }

    return payload;
  }

  return {
    get: (route, signal) => call('GET', route, undefined, signal),
    post: (route, body, signal) => call('POST', route, body, signal),
    patch: (route, body, signal) => call('PATCH', route, body, signal),
    stream: (route, body, signal) =>
      fetch(`${base}${route}`, {
        method: 'POST',
        headers: headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(body),
        signal,
      }),
  };
}

/* ───────────────────────────── the starter ───────────────────────────── */

const JUNK = (rel) =>
  rel === '.gitmodules' ||
  rel === 'Screenshot.png' ||
  ['.git/', 'node_modules/', '.bolt/'].some((prefix) => rel.startsWith(prefix));

/** The pinned starter the server serves (`/api/github-template`), written once to `<evalDir>/starter`. */
async function prepareStarter(api, evalDir, refresh) {
  const starterDir = path.join(evalDir, 'starter');

  if (!refresh && fs.existsSync(path.join(starterDir, 'package.json'))) {
    return starterDir;
  }

  const registry = JSON.parse(fs.readFileSync(path.join(REPO, 'app/config/game-registry.json'), 'utf8'));
  const files = await api.get(`/api/github-template?repo=${encodeURIComponent(registry.starter_repo)}`);

  if (!Array.isArray(files) || files.length === 0) {
    throw new Error('The server returned no starter files.');
  }

  fs.rmSync(starterDir, { recursive: true, force: true });

  for (const file of files) {
    const target = resolveInside(starterDir, file.path);

    if (!target || JUNK(target.rel)) {
      continue;
    }

    fs.mkdirSync(path.dirname(target.abs), { recursive: true });
    fs.writeFileSync(target.abs, file.isBinary ? Buffer.from(file.content ?? '', 'base64') : (file.content ?? ''));
  }

  log(`Starter written to ${starterDir} (${files.length} files).`);

  return starterDir;
}

/** One `npm install` shared by every run (symlinked into each project, the T1 spike's pattern). */
async function prepareNodeModules(starterDir, evalDir) {
  const cacheDir = path.join(evalDir, 'node-cache');
  const pkg = fs.readFileSync(path.join(starterDir, 'package.json'), 'utf8');
  const lockPath = path.join(starterDir, 'package-lock.json');
  const lock = fs.existsSync(lockPath) ? fs.readFileSync(lockPath, 'utf8') : null;
  const stamp = crypto
    .createHash('sha256')
    .update(pkg)
    .update(lock ?? '')
    .digest('hex');
  const stampFile = path.join(cacheDir, '.eval-stamp');

  if (
    fs.existsSync(stampFile) &&
    fs.readFileSync(stampFile, 'utf8') === stamp &&
    fs.existsSync(path.join(cacheDir, 'node_modules'))
  ) {
    return path.join(cacheDir, 'node_modules');
  }

  fs.rmSync(cacheDir, { recursive: true, force: true });
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(path.join(cacheDir, 'package.json'), pkg);

  if (lock) {
    fs.writeFileSync(path.join(cacheDir, 'package-lock.json'), lock);
  }

  log('Installing the starter dependencies once (shared by every run)…');

  const result = await sh('npm', [lock ? 'ci' : 'install', '--no-audit', '--no-fund'], {
    cwd: cacheDir,
    timeout: 900_000,
  });

  if (result.exitCode !== 0) {
    throw new Error(
      `npm ${lock ? 'ci' : 'install'} failed for the starter (exit ${result.exitCode}):\n${tail(result.output, 4000)}`,
    );
  }

  fs.writeFileSync(stampFile, stamp);

  return path.join(cacheDir, 'node_modules');
}

function makeProjectDir(starterDir, nodeModules, dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  fs.cpSync(starterDir, dir, { recursive: true });
  fs.symlinkSync(nodeModules, path.join(dir, 'node_modules'), 'dir');
}

/* ───────────────────────────── the local "browser" ───────────────────────────── */

async function localCheck(dir) {
  const tsc = await sh('npx', ['tsc', '-b', '--force', '--extendedDiagnostics'], { cwd: dir, timeout: 120_000 });
  const typecheckFailed = /error TS\d+/.test(tsc.output) || tsc.exitCode !== 0;
  const build = typecheckFailed
    ? null
    : await sh('npx', ['vite', 'build', '--logLevel', 'error'], { cwd: dir, timeout: 180_000 });

  return buildGameCheckResult({
    tsc,
    build: build ? { ok: build.exitCode === 0, output: tail(build.output.trim(), 4000) } : null,
  });
}

/** Execute one relayed workspace op against the local project — the browser executor's twin. */
async function runWorkspaceOp(run, part) {
  const params = part.params ?? {};

  switch (part.op) {
    case 'write': {
      if (typeof params.path !== 'string' || typeof params.content !== 'string') {
        return { error: 'A write needs a path and text content.' };
      }

      const target = resolveInside(run.dir, params.path);

      if (!target) {
        return { error: `Invalid project path: ${params.path}` };
      }

      fs.mkdirSync(path.dirname(target.abs), { recursive: true });
      fs.writeFileSync(target.abs, params.content);
      run.firstWriteAt ??= Date.now();
      run.writes.add(target.rel);

      return { result: { ok: true } };
    }
    case 'run': {
      const verdict = classifyRunCommand(params.command);

      if (verdict.kind === 'refuse') {
        return { error: verdict.reason };
      }

      let output = '';
      let exitCode = 0;

      for (const segment of verdict.segments) {
        const result = await sh('npm', segment.split(/\s+/).slice(1), { cwd: run.dir, timeout: 300_000 });
        output += `$ ${segment}\n${result.output}${result.output.endsWith('\n') || !result.output ? '' : '\n'}`;
        exitCode = result.exitCode;

        if (exitCode !== 0) {
          break;
        }
      }

      run.commands.push({ command: params.command, exitCode });

      return { result: { exitCode, output: tail(output, RUN_OUTPUT_TAIL_CHARS) } };
    }
    case 'check': {
      const result = await localCheck(run.dir);
      run.checks.push({ at: Date.now(), ok: isStrictPass(result) });

      return { result };
    }
    default:
      return { error: `Unknown workspace operation: ${String(part.op)}` };
  }
}

/* ───────────────────────────── one turn ───────────────────────────── */

async function sendTurn(api, run, { content, creationPhase }) {
  const userMessage = {
    id: crypto.randomUUID(),
    role: 'user',
    content,
    parts: [{ type: 'text', text: content }],
  };

  const body = {
    messages: [...run.messages, userMessage],
    files: buildFileMap(run.dir, { workDir: WORK_DIR }),
    projectId: run.projectId,
    chatId: run.chatId,
    clientId: run.clientId,
    chatMode: 'build',
    engineOverride: run.engine,
    ...(creationPhase ? { creationPhase } : {}),
  };

  const tally = newTurnTally();
  const started = Date.now();
  const pending = [];
  const handled = new Set();

  run.turns += 1;
  log(`  turn ${run.turns}${creationPhase ? ` (${creationPhase})` : ''}: ${content.slice(0, 80)}`);

  /*
   * `receivedAt` is when the data part reached the harness. A result the server no longer waits for
   * (`delivered:false`) is logged with how long the harness held it, so a relay timeout reads as either
   * "the harness was slow" (long hold) or "the part arrived late" (short hold) — never as an engine fault.
   */
  const answer = (generationId, toolCallId, outcome, { op, receivedAt = Date.now() } = {}) =>
    api
      .post(
        '/api/agent/tool-result',
        { generationId, toolCallId, result: outcome.result, error: outcome.error },
        run.signal,
      )
      .then((reply) => {
        const heldMs = Date.now() - receivedAt;
        run.relayHoldMs.push(heldMs);

        if (!reply?.delivered) {
          run.undelivered += 1;
          log(
            `    tool result not delivered (${op ?? 'tool'} ${toolCallId}): held ${(heldMs / 1000).toFixed(1)}s by the harness`,
          );
        }
      })
      .catch((error) => {
        run.undelivered += 1;
        tally.errors.push(`tool-result POST failed: ${error.message}`);
      });

  const onData = (data) => {
    if (data.type === 'workspace-tool-call' && data.toolCallId && data.generationId && !handled.has(data.toolCallId)) {
      handled.add(data.toolCallId);
      run.tools[data.op] = (run.tools[data.op] ?? 0) + 1;

      const receivedAt = Date.now();

      pending.push(
        runWorkspaceOp(run, data)
          .catch((error) => ({ error: error?.message || String(error) }))
          .then((outcome) => answer(data.generationId, data.toolCallId, outcome, { op: data.op, receivedAt })),
      );
    } else if (
      data.type === 'preview-tool-call' &&
      data.toolCallId &&
      data.generationId &&
      !handled.has(data.toolCallId)
    ) {
      handled.add(data.toolCallId);
      run.tools.preview = (run.tools.preview ?? 0) + 1;
      pending.push(answer(data.generationId, data.toolCallId, { error: PREVIEW_UNAVAILABLE }));
    } else if (
      (data.type === 'mcp-tool-call' || data.type === 'bridge-consent') &&
      data.toolCallId &&
      data.generationId &&
      !handled.has(data.toolCallId)
    ) {
      handled.add(data.toolCallId);
      run.tools[data.type] = (run.tools[data.type] ?? 0) + 1;
      pending.push(answer(data.generationId, data.toolCallId, { error: 'Not available in the eval harness.' }));
    } else if (data.type === 'media-task' && data.taskId && !run.mediaTasks.has(data.taskId)) {
      run.mediaTasks.set(data.taskId, Number(data.credits) || 0);
      run.tools.media = (run.tools.media ?? 0) + 1;
    } else if (data.type === 'agent-todos') {
      run.tools.todos = (run.tools.todos ?? 0) + 1;
    }
  };

  try {
    const response = await api.stream('/api/agent', body, run.signal);

    if (!response.ok) {
      const text = await response.text();
      let message = text.slice(0, 500);

      try {
        message = JSON.parse(text).message ?? message;
      } catch {
        // Not JSON.
      }

      tally.errors.push(`HTTP ${response.status}: ${message}`);
    } else {
      const parser = createDataStreamParser();
      const decoder = new TextDecoder();
      const reader = response.body.getReader();

      for (;;) {
        const { done, value } = await reader.read();

        const parts = done ? parser.flush() : parser.push(decoder.decode(value, { stream: true }));

        for (const part of parts) {
          applyStreamPart(tally, part);

          if (part.code === '2' && Array.isArray(part.value)) {
            part.value.forEach((data) => data && typeof data === 'object' && onData(data));
          }
        }

        if (done) {
          break;
        }
      }
    }
  } catch (error) {
    tally.errors.push(run.signal.aborted ? 'The run hit its time limit.' : `Stream failed: ${error.message}`);
  }

  await Promise.allSettled(pending);

  run.messages.push(userMessage, {
    id: crypto.randomUUID(),
    role: 'assistant',
    content: tally.text,
    parts: [{ type: 'text', text: tally.text }],
    annotations: tally.annotations,
  });

  const outcomeState = tally.agentMeta?.outcome?.state ?? null;
  const generationId = tally.agentMeta?.generationId ?? null;

  run.credits += tally.credits;
  run.errors.push(...tally.errors);
  run.lastTurnFailed = tally.errors.length > 0 || !tally.agentMeta;
  run.outcomes.push(outcomeState);

  if (generationId) {
    run.generationIds.push(generationId);
  }

  if (tally.agentMeta?.model) {
    run.models.add(tally.agentMeta.model);
  }

  /*
   * Which engine the SERVER says ran the turn — the override is ignored unless the server opted in, so
   * a run that silently fell back to the deploy's engine must be visible (and is not a success).
   */
  if (tally.agentMeta) {
    run.enginesSeen.add(tally.agentMeta.engine ?? 'legacy');
  }

  log(
    `    → ${outcomeState ?? 'no outcome'} · ${tally.credits} credits · ${((Date.now() - started) / 60000).toFixed(1)} min` +
      (tally.errors.length ? ` · ERROR ${tally.errors[0].slice(0, 160)}` : ''),
  );

  return { tally, outcomeState, failed: tally.errors.length > 0 || !tally.agentMeta };
}

/* ───────────────────────────── the client's creation-plan loop ───────────────────────────── */

/** How many phases a managed turn reports as done (T9), or null when it does not say. */
function phasesCompletedFrom(agentMeta) {
  const value = agentMeta?.creationPhasesCompleted;

  if (value === true) {
    return PHASES.length;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, Math.min(PHASES.length, Math.floor(value)));
  }

  if (Array.isArray(value)) {
    return Math.min(PHASES.length, value.length);
  }

  return null;
}

async function savePlan(api, run, next) {
  const complete = next >= PHASES.length;
  const plan = { v: 1, phases: PHASES.map((p) => p.id), next, done: [] };

  for (let i = 0; i < Math.min(next, PHASES.length); i++) {
    plan.done.push({
      id: PHASES[i].id,
      generationId: run.generationIds.at(-1) ?? '',
      at: new Date().toISOString(),
      state: 'finished',
    });
  }

  await api.patch(`/api/projects/${run.projectId}`, { creationHandoff: complete ? null : { plan } }, run.signal);
}

async function runFirstBuild(api, run, userWords) {
  let next = 0;
  let autoContinue = { index: -1, used: 0 };
  let retries = { index: -1, attempts: 0 };
  let continueMessage = null;

  // New Project mode: the carried prompt, then the plan written at the first send (Chat.client.tsx).
  await api.patch(`/api/projects/${run.projectId}`, { creationHandoff: { userPrompt: userWords } }, run.signal);
  await savePlan(api, run, 0);

  while (next < PHASES.length && !run.signal.aborted) {
    const phase = PHASES[next];
    const content = continueMessage ?? (next === 0 ? userWords : `Step ${next + 1} — ${phase.label.toLowerCase()}.`);
    continueMessage = null;

    const turn = await sendTurn(api, run, { content, creationPhase: phase.id });

    if (turn.failed) {
      const attempts = retries.index === next ? retries.attempts : 0;

      if (attempts >= MAX_CREATION_PHASE_RETRIES || run.signal.aborted) {
        run.stopReason = 'phase-failed';
        return;
      }

      retries = { index: next, attempts: attempts + 1 };
      continue;
    }

    // T9: the managed engine runs every phase in one turn and says how many it finished.
    const reported = phasesCompletedFrom(turn.tally.agentMeta);

    if (reported !== null && reported > next) {
      next = reported;
      await savePlan(api, run, next);
      autoContinue = { index: -1, used: 0 };
      continue;
    }

    const state = turn.outcomeState;

    if (state === 'paused') {
      run.stopReason = 'pause-budget';
      return;
    }

    if (state === 'incomplete' || state === 'unverified') {
      const used = autoContinue.index === next ? autoContinue.used : 0;

      if (used < MAX_AUTO_CONTINUES) {
        autoContinue = { index: next, used: used + 1 };
        continueMessage = KEEP_BUILDING_MESSAGE;
        continue;
      }

      run.stopReason = 'pause-incomplete';

      return;
    }

    next += 1;
    await savePlan(api, run, next);
  }

  run.planComplete = next >= PHASES.length;
}

/* ───────────────────────────── one run ───────────────────────────── */

async function runOne(api, ctx, engine, promptId, index) {
  const def = PROMPTS[promptId];
  const t0 = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('time limit'), ctx.minutes * 60_000);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');

  const run = {
    engine,
    dir: path.join(ctx.evalDir, 'runs', `${stamp}-${promptId}-${engine}-${index}`),
    projectId: null,
    chatId: crypto.randomUUID(),
    clientId: crypto.randomBytes(8).toString('hex'),
    signal: controller.signal,
    messages: [],
    turns: 0,
    credits: 0,
    errors: [],
    outcomes: [],
    generationIds: [],
    models: new Set(),
    enginesSeen: new Set(),
    mediaTasks: new Map(),
    tools: {},
    writes: new Set(),
    commands: [],
    checks: [],
    firstWriteAt: null,
    undelivered: 0,
    relayHoldMs: [],
    lastTurnFailed: false,
    planComplete: def.kind !== 'first-build',
    stopReason: null,
  };

  log(`▶ ${promptId} · ${engine} · run ${index}`);

  let finalCheck = null;

  try {
    makeProjectDir(ctx.starterDir, ctx.nodeModules, run.dir);

    const created = await api.post('/api/projects', { name: def.title, templateId: 'gm_blank_v1' }, run.signal);
    run.projectId = created?.project?.id;

    if (!run.projectId) {
      throw new Error('Project creation returned no id.');
    }

    if (def.kind === 'first-build') {
      await runFirstBuild(api, run, def.text);
    } else if (def.kind === 'edit') {
      await sendTurn(api, run, { content: def.text });
    } else {
      const file = path.join(run.dir, BROKEN_FILE);
      fs.appendFileSync(file, BREAKAGE);

      const broken = await localCheck(run.dir);
      const errors = broken.typecheck === 'unavailable' ? [] : broken.typecheck.errors;

      if (errors.length === 0) {
        throw new Error(
          'The deliberate breakage did not produce a TypeScript error — the fix prompt would be vacuous.',
        );
      }

      await sendTurn(api, run, { content: `The build fails with:\n${errors.join('\n')}\nFix it.` });
    }

    finalCheck = await localCheck(run.dir);
  } catch (error) {
    run.errors.push(controller.signal.aborted ? 'The run hit its time limit.' : `Harness: ${error.message}`);
  } finally {
    clearTimeout(timer);
  }

  const lastOutcome = run.outcomes.at(-1) ?? null;

  const mismatch = engineMismatch(engine, run.enginesSeen);

  if (mismatch) {
    run.errors.push(mismatch);
  }

  const success =
    !!finalCheck &&
    isStrictPass(finalCheck) &&
    run.writes.size > 0 &&
    run.planComplete &&
    !controller.signal.aborted &&
    !run.lastTurnFailed &&
    !run.errors.some((e) => e.startsWith('Harness:') || e.startsWith('Engine mismatch:')) &&
    !['incomplete', 'paused'].includes(lastOutcome);

  const mediaCredits = [...run.mediaTasks.values()].reduce((sum, credits) => sum + credits, 0);
  const rawCostUsd = readRawCost(ctx.dataDir, [...run.generationIds, ...run.mediaTasks.keys()]);

  const record = {
    at: new Date(t0).toISOString(),
    engine,
    prompt: promptId,
    run: index,
    success,
    minutes: +((Date.now() - t0) / 60000).toFixed(2),
    minutesToFirstWrite: run.firstWriteAt ? +((run.firstWriteAt - t0) / 60000).toFixed(2) : null,
    credits: run.credits + mediaCredits,
    turnCredits: run.credits,
    mediaCredits,
    rawCostUsd,
    errorCount: run.errors.length,
    errors: run.errors.slice(0, 5).map((e) => e.slice(0, 400)),
    turns: run.turns,
    outcomes: run.outcomes,
    planComplete: run.planComplete,
    stopReason: run.stopReason,
    timedOut: controller.signal.aborted,
    finalCheck: finalCheck
      ? {
          ok: isStrictPass(finalCheck),
          typecheck: finalCheck.typecheck === 'unavailable' ? 'unavailable' : finalCheck.typecheck.ok,
          errors: [
            ...(finalCheck.typecheck === 'unavailable' ? [] : finalCheck.typecheck.errors),
            ...finalCheck.home.errors,
          ].slice(0, 5),
        }
      : null,
    checks: run.checks.length,
    checksPassed: run.checks.filter((c) => c.ok).length,
    writes: run.writes.size,
    commands: run.commands,
    tools: run.tools,
    undeliveredToolResults: run.undelivered,
    maxRelayHoldSeconds: run.relayHoldMs.length ? +(Math.max(...run.relayHoldMs) / 1000).toFixed(1) : null,
    models: [...run.models],
    enginesSeen: [...run.enginesSeen],
    generationIds: run.generationIds,
    projectId: run.projectId,
    chatId: run.chatId,
    dir: run.dir,
    base: ctx.base,
  };

  fs.mkdirSync(path.dirname(ctx.out), { recursive: true });
  fs.appendFileSync(ctx.out, `${JSON.stringify(record)}\n`);

  log(
    `■ ${promptId} · ${engine} · run ${index}: ${success ? 'SUCCESS' : 'FAIL'} · ${record.minutes} min · ${record.credits} credits` +
      (rawCostUsd !== null ? ` · $${rawCostUsd.toFixed(2)}` : '') +
      (run.errors.length ? ` · ${run.errors[0].slice(0, 160)}` : ''),
  );

  return record;
}

/** Sum `rawCostUsd` from the local generation records (`<data-dir>/generations/<id>.json`), when present. */
function readRawCost(dataDir, ids) {
  let total = 0;
  let found = 0;

  for (const id of ids) {
    try {
      const record = JSON.parse(fs.readFileSync(path.join(dataDir, 'generations', `${id}.json`), 'utf8'));

      if (typeof record.rawCostUsd === 'number') {
        total += record.rawCostUsd;
        found += 1;
      }
    } catch {
      // Not local-FS mode, or not settled yet — raw cost is best-effort.
    }
  }

  return found > 0 ? +total.toFixed(4) : null;
}

/* ───────────────────────────── main ───────────────────────────── */

function printReport(out) {
  const text = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '';
  const { records, skipped } = parseResultsJsonl(text);

  const shown = out.startsWith(`${REPO}${path.sep}`) ? path.relative(REPO, out) : out;

  console.log(`\nEngine eval — ${records.length} run(s) from ${shown}\n`);
  console.log(formatReport(aggregateResults(records)));

  if (skipped > 0) {
    console.log(`\n(${skipped} malformed line(s) skipped)`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || args.h) {
    console.log(HELP);
    return;
  }

  const out = path.resolve(REPO, typeof args.out === 'string' ? args.out : '.data/engine-eval/results.jsonl');

  if (args.report) {
    printReport(out);
    return;
  }

  const engines = String(args.engines ?? 'legacy,managed')
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean);
  const prompts = String(args.prompts ?? Object.keys(PROMPTS).join(','))
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  const n = Math.max(1, Number.parseInt(String(args.n ?? '1'), 10) || 1);
  const minutes = Math.max(1, Number(args.minutes ?? 45) || 45);
  const base = String(args.base ?? 'http://localhost:5173').replace(/\/+$/, '');

  for (const engine of engines) {
    if (engine !== 'legacy' && engine !== 'managed') {
      throw new Error(`Unknown engine "${engine}" (legacy | managed).`);
    }
  }

  for (const prompt of prompts) {
    if (!PROMPTS[prompt]) {
      throw new Error(`Unknown prompt "${prompt}" (${Object.keys(PROMPTS).join(' | ')}).`);
    }
  }

  // Run projects live OUTSIDE the repo — see `resolveWorkDir` (inside it, the dev server's watcher drops tool results).
  const evalDir = resolveWorkDir({ arg: args['work-dir'], repo: REPO, tmpdir: os.tmpdir() });
  const api = makeApi(base, typeof args.cookie === 'string' ? args.cookie : undefined);

  try {
    await fetch(`${base}/api/health`);
  } catch (error) {
    throw new Error(`No server at ${base} (${error.message}). Start it with AGENT_ENGINE_EVAL_OVERRIDE=true pnpm dev.`);
  }

  const starterDir = await prepareStarter(api, evalDir, !!args['refresh-starter']);
  const nodeModules = await prepareNodeModules(starterDir, evalDir);

  const ctx = {
    base,
    out,
    evalDir,
    starterDir,
    nodeModules,
    minutes,
    dataDir: path.resolve(REPO, typeof args['data-dir'] === 'string' ? args['data-dir'] : '.data'),
  };

  log(`Engines ${engines.join(', ')} · prompts ${prompts.join(', ')} · n=${n} · ${base}`);
  log('Reminder: the server must run with AGENT_ENGINE_EVAL_OVERRIDE=true, or every run uses its AGENT_ENGINE.');

  // Interleave engines inside each repetition so time-of-day drift hits both engines alike.
  for (let i = 1; i <= n; i++) {
    for (const prompt of prompts) {
      for (const engine of engines) {
        await runOne(api, ctx, engine, prompt, i);
      }
    }
  }

  printReport(out);
}

main().catch((error) => {
  console.error(`engine-eval: ${error.message}`);
  process.exitCode = 1;
});
