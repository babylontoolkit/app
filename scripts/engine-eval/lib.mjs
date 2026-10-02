/*
 * Pure helpers for the engine eval harness (`scripts/engine-eval.mjs`, managed-agents-engine plan T11).
 *
 * Everything here is deterministic and side-effect free (the FileMap builder reads a directory and
 * nothing else), so it is unit-tested in `lib.spec.ts`: the data-stream parser, the typecheck verdict,
 * the game-check result the harness hands back to the server, the run-command policy, and the report
 * maths that turn the results JSONL into the T12 comparison table.
 */
import fs from 'node:fs';
import path from 'node:path';

/* ───────────────────────────── AI SDK data stream (ai@4) ───────────────────────────── */

/**
 * The AI SDK data stream is newline-delimited `CODE:JSON` lines (`formatDataStreamPart`): `0` text,
 * `g` reasoning, `2` data parts (an array), `8` message annotations (an array), `3` an error string,
 * plus step/finish bookkeeping (`e`, `d`, `f`). A network chunk can end mid-line — even mid-JSON — so
 * the parser buffers until a newline and only then decodes.
 *
 * Returns `{ push(chunk) → parts[], flush() → parts[] }`; each part is `{ code, value }`, or
 * `{ code, raw, invalid: true }` when the payload is not JSON (never thrown — a harness that dies on one
 * odd line loses a whole paid run).
 */
export function createDataStreamParser() {
  let buffer = '';

  const decode = (line) => {
    const colon = line.indexOf(':');

    if (colon <= 0) {
      return { code: '', raw: line, invalid: true };
    }

    const code = line.slice(0, colon);
    const raw = line.slice(colon + 1);

    try {
      return { code, value: JSON.parse(raw) };
    } catch {
      return { code, raw, invalid: true };
    }
  };

  const drain = (final) => {
    const parts = [];
    let newline = buffer.indexOf('\n');

    while (newline !== -1) {
      const line = buffer.slice(0, newline).replace(/\r$/, '');
      buffer = buffer.slice(newline + 1);

      if (line.trim()) {
        parts.push(decode(line));
      }

      newline = buffer.indexOf('\n');
    }

    if (final && buffer.trim()) {
      parts.push(decode(buffer.replace(/\r$/, '')));
      buffer = '';
    }

    return parts;
  };

  return {
    push(chunk) {
      buffer += chunk;
      return drain(false);
    },
    flush() {
      return drain(true);
    },
  };
}

/**
 * Fold one parsed part into a turn's running tally. `turn` is mutated and returned. Data parts (`2`) and
 * annotations (`8`) arrive as arrays; each element is handled on its own.
 */
export function applyStreamPart(turn, part) {
  if (part.invalid) {
    turn.invalidLines += 1;
    return turn;
  }

  switch (part.code) {
    case '0':
      turn.text += String(part.value ?? '');
      break;
    case 'g':
      turn.reasoningChars += String(part.value ?? '').length;
      break;
    case '3':
      turn.errors.push(String(part.value ?? 'Unknown stream error'));
      break;
    case '2':
      for (const data of Array.isArray(part.value) ? part.value : [part.value]) {
        if (data && typeof data === 'object') {
          turn.data.push(data);
        }
      }

      break;
    case '8':
      for (const annotation of Array.isArray(part.value) ? part.value : [part.value]) {
        if (!annotation || typeof annotation !== 'object') {
          continue;
        }

        turn.annotations.push(annotation);

        if (annotation.type === 'credits') {
          turn.credits += Number(annotation.value?.creditsCharged) || 0;
        } else if (annotation.type === 'agentMeta') {
          turn.agentMeta = annotation.value ?? null;
        } else if (annotation.type === 'usage') {
          turn.usage = annotation.value ?? null;
        }
      }

      break;
    default:
      break;
  }

  return turn;
}

export function newTurnTally() {
  return {
    text: '',
    reasoningChars: 0,
    errors: [],
    data: [],
    annotations: [],
    credits: 0,
    agentMeta: null,
    usage: null,
    invalidLines: 0,
  };
}

/**
 * The engine the server REPORTED for each turn (`agentMeta.engine`; absent = legacy) against the engine the
 * run asked for. The body's `engineOverride` is ignored unless the server opted in
 * (AGENT_ENGINE_EVAL_OVERRIDE=true), so without this check a run silently measures the deploy's engine and
 * files the number under the other one — a wrong T12 decision that throws nothing. Returns the error
 * sentence, or null when every turn ran on the requested engine.
 */
export function engineMismatch(asked, seen) {
  const engines = [...seen];
  const wrong = engines.filter((engine) => engine !== asked);

  if (wrong.length === 0) {
    return null;
  }

  return `Engine mismatch: asked for ${asked}, the server ran ${engines.join('+')} (is AGENT_ENGINE_EVAL_OVERRIDE=true set?).`;
}

/**
 * Where run projects, the starter copy and the shared node_modules live. NEVER inside the repo: the dev
 * server's Vite watcher covers the whole repo (`.data/` included), and every run writes a `tsconfig.json`
 * and a `dist/index.html` — Vite answers with "changed tsconfig file detected … forcing full reload",
 * clearing the SSR module graph, so the next `/api/agent/tool-result` request loads a FRESH `mcp-relay`
 * whose registry is empty. Every tool result then answers `delivered:false`, the turn waits out the relay
 * timeout and the run reads as an engine failure. Measured 2026-10-01: every relayed write of the first
 * matrix hit the 30 s timeout this way. Default: `<tmpdir>/btk-engine-eval`. Throws for a dir inside `repo`.
 */
export function resolveWorkDir({ arg, repo, tmpdir }) {
  const dir = path.resolve(typeof arg === 'string' && arg.trim() ? arg : path.join(tmpdir, 'btk-engine-eval'));
  const rel = path.relative(path.resolve(repo), dir);

  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
    throw new Error(
      `--work-dir ${dir} is inside the repo; the dev server's file watcher would reload the server module graph on every run and drop tool results. Use a directory outside ${repo}.`,
    );
  }

  return dir;
}

/* ───────────────────────────── the game check ───────────────────────────── */

const CHECK_MAX_ERRORS = 30; // mirrors workspace-protocol-types.ts
const CHECK_ERROR_MAX_CHARS = 300;

function capErrors(messages) {
  return messages.slice(0, CHECK_MAX_ERRORS).map((message) => String(message).slice(0, CHECK_ERROR_MAX_CHARS));
}

/**
 * A `tsc -b --force --extendedDiagnostics` run → the `typecheck` field of a GameCheckResult. A port of
 * `parseTypecheckOutput` (`app/lib/agent-workspace/executor.ts`): a clean exit is a pass only when tsc
 * reports a non-zero `Lines of TypeScript`, otherwise it is `'unavailable'` with a reason.
 */
export function parseTypecheckOutput(exitCode, output) {
  const lines = String(output ?? '').split(/\r?\n/);
  const errors = lines.filter((line) => /error TS\d+/.test(line));

  if (errors.length > 0) {
    return { value: { ok: false, errors: capErrors(errors) } };
  }

  const counts = [...String(output ?? '').matchAll(/Lines of TypeScript:\s+(\d+)/g)].map((match) => Number(match[1]));
  const sawTypeScript = counts.some((count) => count > 0);

  if (exitCode === 0) {
    if (!sawTypeScript) {
      return {
        value: 'unavailable',
        reason:
          counts.length === 0
            ? 'tsc exited cleanly but reported no diagnostics, so there is no evidence it checked any file.'
            : 'tsc exited cleanly having read 0 lines of TypeScript — it did not see the project, so this is not a pass.',
      };
    }

    return { value: { ok: true, errors: [] } };
  }

  if (exitCode === 127 || /not found|ENOENT|Cannot find module/i.test(String(output ?? ''))) {
    return { value: 'unavailable', reason: `tsc could not run (exit ${exitCode}).` };
  }

  const lastLine = lines.filter((line) => line.trim()).pop() ?? `tsc exited with code ${exitCode}`;

  return { value: { ok: false, errors: capErrors([lastLine]) } };
}

/**
 * The harness's answer to a `check` op, in the GameCheckResult shape the server expects
 * (`workspace-protocol-types.ts`). There is no browser here, so:
 *   - `play` is always `null` (no scene probe) — the server then judges on typecheck + home;
 *   - a failed production build (`vite build`) is reported as `home.errors`, so it fails the check the
 *     way a broken landing page would;
 *   - `screenshot` is `null`.
 */
export function buildGameCheckResult({ tsc, build }) {
  const verdict = parseTypecheckOutput(tsc.exitCode, tsc.output);
  const homeErrors = build && !build.ok ? capErrors([`Production build (vite build) failed:\n${build.output}`]) : [];
  const typecheckOk = verdict.value === 'unavailable' || verdict.value.ok;

  return {
    ok: typecheckOk && homeErrors.length === 0,
    typecheck: verdict.value,
    ...(verdict.reason ? { typecheckReason: verdict.reason } : {}),
    home: { errors: homeErrors },
    play: null,
    screenshot: null,
  };
}

/** Did a local check pass, as a strict verdict for the run record (`'unavailable'` is NOT a pass here). */
export function isStrictPass(check) {
  return !!check && check.ok === true && check.typecheck !== 'unavailable';
}

/* ───────────────────────────── run-command policy ───────────────────────────── */

export const RUN_REFUSED_SENTENCE =
  'That command is not allowed. Allowed: npm install <pkg>, npm run <script> (not dev or preview).';

export const INSTALL_REFUSED_SENTENCE =
  'Refused in this environment: dependencies are fixed for this run. Use what the starter provides.';

/**
 * What the harness does with a `run` op: `{ kind: 'allow', segments }`, `{ kind: 'refuse', reason }`.
 * Mirrors the browser's allow-list (`npm install <pkg>` / `npm run <script>`, never dev/preview, `&&`
 * chains), except installs are refused — every run shares one installed `node_modules`, and a run that
 * installed a package would make the next run's starter differ (the T1 spike's rule).
 */
export function classifyRunCommand(command) {
  const text = String(command ?? '').trim();

  if (!text) {
    return { kind: 'refuse', reason: 'A command is required.' };
  }

  const segments = text
    .split('&&')
    .map((segment) => segment.trim())
    .filter(Boolean);

  for (const segment of segments) {
    const argv = segment.split(/\s+/);

    if (argv[0] !== 'npm') {
      return { kind: 'refuse', reason: RUN_REFUSED_SENTENCE };
    }

    if (['install', 'i', 'uninstall', 'remove', 'un', 'ci', 'add'].includes(argv[1] ?? '')) {
      return { kind: 'refuse', reason: INSTALL_REFUSED_SENTENCE };
    }

    if (argv[1] !== 'run' || !/^[\w:.-]+$/.test(argv[2] ?? '') || argv.length > 3) {
      return { kind: 'refuse', reason: RUN_REFUSED_SENTENCE };
    }

    if (argv[2] === 'dev' || argv[2] === 'preview') {
      return { kind: 'refuse', reason: `${RUN_REFUSED_SENTENCE} The dev server is already running.` };
    }
  }

  return { kind: 'allow', segments };
}

/* ───────────────────────────── the FileMap the client sends ───────────────────────────── */

export const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.vite', '.cache']);

/** Mirrors the extensions `isBinaryPath` (`app/lib/binary/binary-files.ts`) treats as bytes. */
export const BINARY_EXTENSIONS = new Set(
  (
    'png jpg jpeg gif webp avif bmp ico icns tif tiff tga psd dds ktx ktx2 basis exr hdr ' +
    'glb gltf bin fbx obj babylon babylonbinarymeshdata incremental draco ply stl usdz ' +
    'mp3 wav ogg oga m4a aac flac opus weba mka mp4 webm mov avi mkv m4v ogv 3gp apng ' +
    'ttf otf woff woff2 eot wasm zip gz br tar 7z rar pdf bz2'
  ).split(' '),
);

export function isBinaryPath(filePath) {
  const name = String(filePath).split('/').pop() ?? '';
  const parts = name.split('.');

  return parts.length >= 2 && BINARY_EXTENSIONS.has(parts.pop().toLowerCase());
}

/**
 * Build the `files` body field the browser sends (`FileMap`, `app/lib/.server/llm/constants.ts`) from a
 * local project directory: keys are sandbox-absolute (`<workDir>/<rel>`), folders are `{type:'folder'}`,
 * text files carry their content, and binaries carry `isBinary: true` + `size` with EMPTY content (binary
 * bytes never reach the server or the model). `node_modules`, `dist`, `.git` are skipped; so are
 * `*.tsbuildinfo` (a typecheck artefact the browser's map never holds).
 */
export function buildFileMap(rootDir, { workDir = '/home/project' } = {}) {
  /** @type {Record<string, any>} */
  const map = {};

  const walk = (dir, rel) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) {
        continue;
      }

      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      const abs = path.join(dir, entry.name);
      const key = `${workDir}/${childRel}`;

      if (entry.isDirectory()) {
        map[key] = { type: 'folder' };
        walk(abs, childRel);
      } else if (entry.isFile()) {
        if (entry.name.endsWith('.tsbuildinfo')) {
          continue;
        }

        const bytes = fs.readFileSync(abs);
        const binary = isBinaryPath(childRel) || bytes.subarray(0, 8000).includes(0);

        map[key] = binary
          ? { type: 'file', content: '', isBinary: true, size: bytes.length }
          : { type: 'file', content: bytes.toString('utf8'), isBinary: false };
      }
    }
  };

  walk(rootDir, '');

  return map;
}

/** A project-relative path from the agent, resolved inside `root`, or `null` when it escapes it. */
export function resolveInside(root, relPath) {
  const cleaned = String(relPath ?? '')
    .replace(/^\/home\/project\/?/, '')
    .replace(/^\.?\/+/, '');
  const rel = path.posix.normalize(cleaned);

  if (!cleaned || rel === '.' || rel.startsWith('..') || path.posix.isAbsolute(rel)) {
    return null;
  }

  return { rel, abs: path.join(root, ...rel.split('/')) };
}

/* ───────────────────────────── the report ───────────────────────────── */

export function median(values) {
  const nums = values.filter((value) => typeof value === 'number' && Number.isFinite(value)).sort((a, b) => a - b);

  if (nums.length === 0) {
    return null;
  }

  const mid = Math.floor(nums.length / 2);

  return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
}

/** Parse a results JSONL text; a malformed line is skipped (and counted), never fatal. */
export function parseResultsJsonl(text) {
  const records = [];
  let skipped = 0;

  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }

    try {
      const record = JSON.parse(line);

      if (record && typeof record === 'object' && record.engine && record.prompt) {
        records.push(record);
      } else {
        skipped += 1;
      }
    } catch {
      skipped += 1;
    }
  }

  return { records, skipped };
}

/**
 * Group run records by (prompt, engine) and compute the comparison: runs, successes, success rate,
 * median minutes (total and to first write), median credits, median raw USD, failed runs and total
 * errors. Rows are ordered by prompt (first-seen order), then engine name.
 */
export function aggregateResults(records) {
  const groups = new Map();
  const promptOrder = [];

  for (const record of records) {
    if (!promptOrder.includes(record.prompt)) {
      promptOrder.push(record.prompt);
    }

    const key = `${record.prompt}\u0000${record.engine}`;

    if (!groups.has(key)) {
      groups.set(key, { prompt: record.prompt, engine: record.engine, records: [] });
    }

    groups.get(key).records.push(record);
  }

  return [...groups.values()]
    .sort((a, b) => promptOrder.indexOf(a.prompt) - promptOrder.indexOf(b.prompt) || a.engine.localeCompare(b.engine))
    .map(({ prompt, engine, records: rs }) => {
      const successes = rs.filter((r) => r.success === true).length;

      return {
        prompt,
        engine,
        runs: rs.length,
        successes,
        successRate: rs.length ? successes / rs.length : 0,
        medianMinutes: median(rs.map((r) => r.minutes)),
        medianFirstWriteMinutes: median(rs.map((r) => r.minutesToFirstWrite)),
        medianCredits: median(rs.map((r) => r.credits)),
        medianRawUsd: median(rs.map((r) => r.rawCostUsd)),
        failedRuns: rs.length - successes,
        errors: rs.reduce((sum, r) => sum + (Number(r.errorCount) || 0), 0),
      };
    });
}

const fmt = (value, digits = 1) => (value === null || value === undefined ? '—' : Number(value).toFixed(digits));

/** The markdown comparison table (the T12 evidence). */
export function formatReport(rows) {
  if (rows.length === 0) {
    return 'No eval results yet.';
  }

  const header =
    '| Prompt | Engine | Runs | Success | Median min | Median min to first write | Median credits | Median raw $ | Failed runs | Errors |\n' +
    '|---|---|---|---|---|---|---|---|---|---|';

  const lines = rows.map(
    (row) =>
      `| ${row.prompt} | ${row.engine} | ${row.runs} | ${row.successes}/${row.runs} (${Math.round(
        row.successRate * 100,
      )}%) | ${fmt(row.medianMinutes)} | ${fmt(row.medianFirstWriteMinutes)} | ${fmt(row.medianCredits, 0)} | ${fmt(
        row.medianRawUsd,
        2,
      )} | ${row.failedRuns} | ${row.errors} |`,
  );

  return [header, ...lines].join('\n');
}

/* ───────────────────────────── CLI ───────────────────────────── */

/** `--key value` / `--flag` → an object. A flag followed by another `--x` (or nothing) is `true`. */
export function parseArgs(argv) {
  const args = {};

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];

    if (!token.startsWith('--')) {
      continue;
    }

    const key = token.slice(2);
    const next = argv[i + 1];

    if (next === undefined || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i++;
    }
  }

  return args;
}
