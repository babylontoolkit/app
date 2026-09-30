/**
 * The browser half of the tool loop's workspace relay (tool-loop plan D5–D8).
 *
 * The server's `write_file` / `edit_file` / `run_command` / `check_game` tools emit a
 * `workspace-tool-call` data part; `Chat.client.tsx` hands it to {@link runWorkspaceToolCall}, which
 * performs it in the user's sandbox and returns `{ result }` or `{ error }`. The chat POSTs that to
 * `/api/agent/tool-result` only AFTER this resolves — for a write, only after the bytes are on the
 * sandbox FS and in the file map, which is what makes relayed writes safe for the end-of-turn
 * checkpoint (it cannot see them otherwise).
 *
 * Rules that bind this module, each silent when broken:
 * - Commands run through `sandbox.spawn`, NEVER the shared terminal (`BoltShell.executeCommand` sends
 *   Ctrl-C into the terminal running `npm run dev`).
 * - Every command passes `isAllowedShellCommand`, and `npm run dev` / `npm run preview` are refused:
 *   the dev server is already running, and a second one would never exit.
 * - An agent write goes through `workbenchStore.writeAgentFile`, never `createFile`/`saveFile`
 *   (an agent write must not schedule a persistence top-up).
 * - Text only. Binaries come from the media tools.
 */
import {
  CHECK_ERROR_MAX_CHARS,
  CHECK_MAX_ERRORS,
  DISALLOWED_RUN_SCRIPTS,
  HOME_SETTLE_MS,
  NAV_STATE_STORE_KEY,
  PLAY_MIN_SETTLE_MS,
  PLAY_SCENE_DEADLINE_MS,
  PLAY_SCENE_POLL_MS,
  PREVIEW_NAV_READY_MS,
  RUN_OUTPUT_TAIL_CHARS,
  TYPECHECK_TIMEOUT_MS,
  WORKSPACE_RUN_TIMEOUT_MS,
  type GameCheckResult,
  type WorkspaceCheckParams,
  type WorkspaceRunResult,
  type WorkspaceToolCallPart,
} from '~/lib/agent/workspace-protocol-types';
import {
  capturePreviewScreenshot,
  evaluateInPreview,
  isPreviewBridgeReady,
  notifyPreviewReloading,
  readPreviewErrors,
} from '~/lib/preview/bridge';
import { isAllowedShellCommand } from '~/lib/runtime/shell-allowlist';
import { sandbox } from '~/lib/sandbox';
import { requestPreviewReload } from '~/lib/stores/preview-reload';
import { beginWorkspaceCheck, endWorkspaceCheck } from './check-window';
import { workbenchStore } from '~/lib/stores/workbench';

/**
 * `npm uninstall` is NOT in the shell allow-list (`isAllowedShellCommand` permits only `npm install`
 * and `npm run`), so the sentence does not offer it (plan Error policy).
 */
export const RUN_REFUSED_SENTENCE =
  'That command is not allowed. Allowed: npm install <pkg>, npm run <script> (not dev or preview).';

export const NO_PREVIEW_SENTENCE =
  'The preview is not running yet; the platform is restarting it — call check_game again in a moment.';

/** The conventional "timed out" exit status (coreutils `timeout`). */
export const TIMEOUT_EXIT_CODE = 124;

const INSTALL_SUBCOMMANDS = new Set(['install', 'i', 'uninstall', 'remove', 'un']);

const NAV_POLL_MS = 250;

/** Delay before an in-document navigation, so the evaluate reply leaves the document first. */
const NAV_DELAY_MS = 100;

/** How long to keep draining a finished process's output before giving up on the stream. */
const OUTPUT_DRAIN_MS = 250;

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function tail(text: string, max: number): string {
  return text.length > max ? text.slice(text.length - max) : text;
}

function capErrors(messages: string[]): string[] {
  return messages.slice(0, CHECK_MAX_ERRORS).map((message) => String(message).slice(0, CHECK_ERROR_MAX_CHARS));
}

interface SegmentResult {
  exitCode: number;
  output: string;
  timedOut: boolean;
}

/** Run one argv in the sandbox, off the shared terminal, racing its own timeout. */
async function runSegment(argv: string[], timeoutMs: number): Promise<SegmentResult> {
  const sb = await sandbox;
  const proc = await sb.spawn(argv[0], argv.slice(1));

  let output = '';
  const reader = proc.output.getReader();

  const pump = (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();

        if (done) {
          break;
        }

        output += value;

        // Keep memory bounded on a chatty install; only the tail is ever returned.
        if (output.length > RUN_OUTPUT_TAIL_CHARS * 4) {
          output = tail(output, RUN_OUTPUT_TAIL_CHARS * 2);
        }
      }
    } catch {
      // A killed process may error its stream; what was read is kept.
    }
  })();

  const TIMED_OUT = Symbol('timeout');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
  });

  const outcome = await Promise.race([proc.exit, timeout]);
  clearTimeout(timer);

  const timedOut = outcome === TIMED_OUT;

  if (timedOut) {
    try {
      proc.kill();
    } catch {
      // Already gone.
    }
  }

  await Promise.race([pump, sleep(OUTPUT_DRAIN_MS)]);
  reader.cancel().catch(() => undefined);

  return {
    exitCode: timedOut ? TIMEOUT_EXIT_CODE : (outcome as number),
    output: output.replace(ANSI, ''),
    timedOut,
  };
}

function refusalFor(command: string): string | undefined {
  const verdict = isAllowedShellCommand(command);

  if (!verdict.allowed) {
    return verdict.reason ? `${RUN_REFUSED_SENTENCE} (${verdict.reason})` : RUN_REFUSED_SENTENCE;
  }

  for (const segment of command.split('&&')) {
    const [program, subcommand, script] = segment.trim().split(/\s+/);

    if (
      program === 'npm' &&
      subcommand === 'run' &&
      (DISALLOWED_RUN_SCRIPTS as readonly string[]).includes(script ?? '')
    ) {
      return `${RUN_REFUSED_SENTENCE} The dev server is already running.`;
    }
  }

  return undefined;
}

/**
 * Run an allow-listed command (D7). `&&` segments run in order and stop at the first non-zero exit;
 * the whole call shares one deadline. A timeout kills the process and reports exit code 124.
 * Throws the refusal sentence for a command outside the allow-list.
 */
export async function runCommand(command: string, timeoutMs: number): Promise<WorkspaceRunResult> {
  const refusal = refusalFor(command);

  if (refusal) {
    throw new Error(refusal);
  }

  const deadline = Date.now() + timeoutMs;
  const segments = command
    .split('&&')
    .map((segment) => segment.trim())
    .filter(Boolean);

  let output = '';
  let exitCode = 0;
  let installed = false;

  for (const segment of segments) {
    const argv = segment.split(/\s+/);

    if (INSTALL_SUBCOMMANDS.has(argv[1] ?? '')) {
      installed = true;
    }

    const remaining = Math.max(0, deadline - Date.now());
    const result = await runSegment(argv, remaining);

    output += `$ ${segment}\n${result.output}${result.output.endsWith('\n') || !result.output ? '' : '\n'}`;
    exitCode = result.exitCode;

    if (result.timedOut) {
      output += `[timed out after ${Math.round(timeoutMs / 1000)}s — the process was stopped]\n`;
      break;
    }

    if (exitCode !== 0) {
      break;
    }
  }

  const result: WorkspaceRunResult = { exitCode, output: tail(output, RUN_OUTPUT_TAIL_CHARS) };

  if (installed) {
    try {
      const sb = await sandbox;
      result.packageJson = await sb.fs.readFile('package.json', 'utf-8');
    } catch {
      // No package.json to report — the command's own output says why.
    }
  }

  return result;
}

function isNoPreviewError(error: unknown): boolean {
  return /No preview is running/i.test((error as Error)?.message ?? '');
}

/**
 * Navigate the running preview document to `path` (optionally seeding the play contract's
 * `NavigationState` first) and wait for the new document's agent to report ready.
 *
 * ⚠️ The order differs from the plan's D8 text on purpose: `notifyPreviewReloading()` flips the
 * bridge's `ready` flag false, and a request made while not-ready WAITS for a ready event — which the
 * current document never sends again — so notifying first makes the evaluate time out and the
 * navigation never happens. Instead the evaluate schedules the navigation with a delay and returns at
 * once; `ready` is cleared the moment the reply arrives, before the delay elapses.
 */
export async function navigatePreview(path: string, navState?: Record<string, unknown>): Promise<void> {
  const seed = navState
    ? `sessionStorage.setItem(${JSON.stringify(NAV_STATE_STORE_KEY)}, ${JSON.stringify(JSON.stringify(navState))});`
    : '';
  const expression = `(()=>{ ${seed} setTimeout(() => location.assign(${JSON.stringify(path)}), ${NAV_DELAY_MS}); return true; })()`;

  try {
    await evaluateInPreview(expression);
  } catch (error) {
    if (isNoPreviewError(error)) {
      throw error;
    }

    // Ignored when the ready poll below then succeeds (the document may have unloaded mid-reply).
  }

  notifyPreviewReloading();

  const deadline = Date.now() + PREVIEW_NAV_READY_MS;

  while (Date.now() < deadline) {
    await sleep(NAV_POLL_MS);

    if (isPreviewBridgeReady()) {
      return;
    }
  }

  throw new Error(`The preview did not come back after navigating to ${path}.`);
}

/**
 * The errors the preview recorded since `since`.
 *
 * 🔴 A READ THAT TIMES OUT IS RETRIED ONCE BEFORE IT BECOMES A GAME ERROR (T10 live, 2026-09-30).
 * Measured on `gen_muop93e1_r1yrx4`: the first check of a turn (a cold `/play` boot while four media
 * renders were landing) reported "Game check found 1 problem" — the preview did not answer the error
 * read within the bridge's 10s — and the model's immediate retry passed with no changes. A busy
 * document is not a broken game, and reporting it as one arms the done-gate and buys a whole check
 * round (~60s) for nothing. The retry waits for the bridge to be ready first; a second failure is still
 * reported, because an error read that never succeeds must not read as a clean game.
 */
async function collectErrors(since: number): Promise<string[]> {
  let lastError: unknown;

  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) {
      const deadline = Date.now() + PREVIEW_NAV_READY_MS;

      while (!isPreviewBridgeReady() && Date.now() < deadline) {
        await sleep(NAV_POLL_MS);
      }
    }

    try {
      return (await readPreviewErrors(since)).map((entry) => entry.message);
    } catch (error) {
      lastError = error;

      if (isNoPreviewError(error)) {
        break;
      }
    }
  }

  return [`Could not read the preview's errors: ${(lastError as Error).message}`];
}

/** The invocation `check_game` typechecks with. Forced, so an up-to-date build info cannot skip the check. */
export const TYPECHECK_ARGV = ['npx', 'tsc', '-b', '--force', '--extendedDiagnostics'] as const;

export type TypecheckVerdict = { value: GameCheckResult['typecheck']; reason?: string };

/**
 * Read a `tsc -b --extendedDiagnostics` run into a verdict. PURE, so the non-vacuous rule is testable.
 *
 * 🔴 **A clean exit is only a pass if tsc actually READ the project** (verifier finding, 2026-09-30).
 * In Nodepod `npx tsc -p tsconfig.app.json` exits 0 having seen `Files: 0` — its `npx` takes `-p` as its
 * own `--package` flag, so tsc falls back to the root `tsconfig.json` (`files: []`, references only)
 * and "passes" a project it never opened. `tsc -b` does not hit that, but "exit 0" can never tell the
 * two apart, so the verdict REQUIRES the diagnostics' `Lines of TypeScript` to be non-zero: a run that
 * saw no TypeScript is `'unavailable'` with a reason, never `{ ok: true }`.
 */
export function parseTypecheckOutput(exitCode: number, output: string): TypecheckVerdict {
  const lines = output.split(/\r?\n/);
  const errors = lines.filter((line) => /error TS\d+/.test(line));

  if (errors.length > 0) {
    return { value: { ok: false, errors: capErrors(errors) } };
  }

  const counts = [...output.matchAll(/Lines of TypeScript:\s+(\d+)/g)].map((match) => Number(match[1]));
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

  // Non-zero with no TS diagnostics: the compiler never ran (missing npx/tsc) — not a verdict.
  if (exitCode === 127 || /not found|ENOENT|Cannot find module/i.test(output)) {
    return { value: 'unavailable', reason: `tsc could not run (exit ${exitCode}).` };
  }

  const lastLine = lines.filter((line) => line.trim()).pop() ?? `tsc exited with code ${exitCode}`;

  return { value: { ok: false, errors: capErrors([lastLine]) } };
}

/*
 * ─── tsbuildinfo litter ─────────────────────────────────────────────────────────────────────────────
 *
 * `tsc -b` writes `<config>.tsbuildinfo` beside each tsconfig (or at a `tsBuildInfoFile` path), i.e.
 * INTO the user's project — which the mirror then carries to their disk and their repository. The
 * check is a READ of the project, so it must leave the tree as it found it: build-info files that did
 * not exist before are removed, and ones that did (the starter ships two) get their bytes back.
 * Never a pre-existing file deleted, and never a cleanup failure turned into a check failure.
 */
const BUILD_INFO = /\.tsbuildinfo$/i;
const TSCONFIG = /^tsconfig(\.[\w-]+)?\.json$/i;
const BUILD_INFO_OPTION = /"tsBuildInfoFile"\s*:\s*"([^"]+)"/g;

type BuildInfoSnapshot = Map<string, string | undefined>;

/** A `tsBuildInfoFile` value as a project-relative path, or `null` if it points outside the project. */
function projectRelative(path: string): string | null {
  const rel = path.trim().replace(/^\.\//, '');

  if (!rel || rel.startsWith('/') || rel.split('/').includes('..')) {
    return null;
  }

  return rel;
}

/** Every build-info path tsc may write: root `*.tsbuildinfo` plus any `tsBuildInfoFile` a root tsconfig names. */
async function buildInfoCandidates(names: string[]): Promise<Set<string>> {
  const sb = await sandbox;
  const paths = new Set(names.filter((name) => BUILD_INFO.test(name)));

  for (const name of names.filter((n) => TSCONFIG.test(n))) {
    try {
      const text = await sb.fs.readFile(name, 'utf-8');

      for (const match of String(text).matchAll(BUILD_INFO_OPTION)) {
        const rel = projectRelative(match[1]);

        if (rel) {
          paths.add(rel);
        }
      }
    } catch {
      // An unreadable tsconfig names nothing.
    }
  }

  return paths;
}

/** What exists before the typecheck, with its bytes. `null` = could not look, so clean nothing. */
async function snapshotBuildInfo(): Promise<{ snapshot: BuildInfoSnapshot; candidates: Set<string> } | null> {
  try {
    const sb = await sandbox;
    const names = await sb.fs.readdir('.');
    const candidates = await buildInfoCandidates(names);
    const snapshot: BuildInfoSnapshot = new Map();

    for (const path of candidates) {
      try {
        snapshot.set(path, await sb.fs.readFile(path, 'utf-8'));
      } catch {
        /*
         * Listed but unreadable still EXISTED — record it so it is never deleted. Named only by a
         * tsconfig and not readable = not there yet (tsc may create it).
         */
        if (names.includes(path)) {
          snapshot.set(path, undefined);
        }
      }
    }

    return { snapshot, candidates };
  } catch {
    return null;
  }
}

async function restoreBuildInfo(before: { snapshot: BuildInfoSnapshot; candidates: Set<string> } | null) {
  if (!before) {
    return;
  }

  try {
    const sb = await sandbox;
    const after = await buildInfoCandidates(await sb.fs.readdir('.'));

    for (const path of new Set([...after, ...before.candidates])) {
      const original = before.snapshot.get(path);

      try {
        if (!before.snapshot.has(path)) {
          await sb.fs.rm(path, { force: true });
        } else if (original !== undefined && (await sb.fs.readFile(path, 'utf-8')) !== original) {
          await sb.fs.writeFile(path, original, 'utf-8');
        }
      } catch {
        // Best effort per file; the check result never depends on it.
      }
    }
  } catch {
    // Could not list the project afterwards — leave it; never guess what to delete.
  }
}

async function runTypecheck(): Promise<TypecheckVerdict> {
  const before = await snapshotBuildInfo();

  try {
    return await runTypecheckOnce();
  } finally {
    await restoreBuildInfo(before);
  }
}

async function runTypecheckOnce(): Promise<TypecheckVerdict> {
  try {
    const result = await runSegment([...TYPECHECK_ARGV], TYPECHECK_TIMEOUT_MS);

    if (result.timedOut) {
      return { value: 'unavailable', reason: `tsc did not finish within ${Math.round(TYPECHECK_TIMEOUT_MS / 1000)}s.` };
    }

    return parseTypecheckOutput(result.exitCode, result.output);
  } catch (error) {
    return { value: 'unavailable', reason: `tsc could not be started: ${(error as Error)?.message ?? error}` };
  }
}

/**
 * The agent script answers `screenshot` with `{ base64, mimeType, blank, … }` (see
 * `preview/agent-script.ts` `takeScreenshot`) — NOT the `dataUrl` that `bridge.ts`'s
 * `PreviewScreenshot` type declares. Both shapes are accepted. A frame the script itself reports as
 * blank is not evidence of anything, so it is dropped rather than shown to the model as "the game".
 */
function toScreenshot(shot: unknown): GameCheckResult['screenshot'] {
  const frame = (shot ?? {}) as { base64?: unknown; mimeType?: unknown; dataUrl?: unknown; blank?: unknown };

  if (frame.blank === true) {
    return null;
  }

  if (typeof frame.base64 === 'string' && frame.base64) {
    return { base64: frame.base64, mimeType: typeof frame.mimeType === 'string' ? frame.mimeType : 'image/jpeg' };
  }

  const match = /^data:([^;,]+);base64,(.*)$/s.exec(typeof frame.dataUrl === 'string' ? frame.dataUrl : '');

  return match ? { mimeType: match[1], base64: match[2] } : null;
}

/**
 * The scene probe, run inside the preview document.
 *
 * ⚠️ Measured live 2026-09-30: the plan's `(await import('/src/babylon/globals')).default.GetScene()`
 * reports NO scene on a rendering game, twice over — the starter's `GameManager` has no `GetScene`, and
 * the extension-less specifier is a DIFFERENT URL from the `/src/babylon/globals.ts` the game loaded,
 * so the browser evaluates a second copy of the module (re-running its top level). So the probe
 * imports the EXACT URLs the document already loaded (read from its resource timing entries — the same
 * module instances, no re-evaluation): Babylon core's `EngineStore.LastCreatedScene` first, the
 * `GameManager.GetScene()` of a starter that has one second.
 */
const SCENE_PROBE = `(async () => {
  const urls = performance.getEntriesByType('resource').map((e) => e.name);
  let s = null;
  const core = urls.find((n) => n.includes('/@babylonjs/core/index.js')) || urls.find((n) => n.includes('@babylonjs_core.js'));
  if (core) {
    const m = await import(core);
    const engines = m.EngineStore?.Instances ?? m.Engine?.Instances ?? [];
    for (const engine of engines) {
      for (const scene of engine?.scenes ?? []) {
        if (!scene.isDisposed && (!s || scene.meshes.length > s.meshes.length)) { s = scene; }
      }
    }
    s = s ?? m.EngineStore?.LastCreatedScene ?? null;
  }
  if (!s) {
    const g = urls.find((n) => n.includes('/src/babylon/globals.ts') || n.includes('/src/babylon/globals.js'));
    if (g) { const gm = (await import(g)).default; s = gm?.GetScene?.() ?? null; }
  }
  if (s && s.isDisposed) { s = null; }
  return { hasScene: !!s, meshes: s?.meshes?.length ?? 0, ready: s?.isReady?.() ?? false };
})()`;

type SceneProbe = { hasScene?: boolean; meshes?: number; ready?: boolean };

/**
 * Poll `/play` for the game's scene (T9 fix loop). Returns as soon as a scene with meshes exists and
 * the minimum settle has passed, otherwise the last probe at the deadline.
 *
 * If the preview reloads under the poll (a Vite full reload after the agent's edits) or ends up off
 * `/play`, it waits for the bridge and re-navigates with the same nav state — ONCE. A single probe
 * after a fixed settle reported "No Babylon scene was created" on a working game (found live).
 */
async function pollForScene(navState: Record<string, unknown>): Promise<{ probe: SceneProbe | null; error?: string }> {
  const startedAt = Date.now();
  const deadline = startedAt + PLAY_SCENE_DEADLINE_MS;
  let renavigated = false;
  let last: SceneProbe | null = null;
  let lastError: string | undefined;

  while (Date.now() < deadline) {
    await sleep(PLAY_SCENE_POLL_MS);

    let lost = !isPreviewBridgeReady();

    if (!lost) {
      try {
        lost = (await evaluateInPreview('location.pathname')) !== '/play';
      } catch {
        lost = true;
      }
    }

    if (lost) {
      if (!renavigated && isPreviewBridgeReady()) {
        renavigated = true;

        try {
          await navigatePreview('/play', navState);
        } catch (error) {
          lastError = (error as Error).message;
        }
      }

      continue;
    }

    try {
      last = (await evaluateInPreview(SCENE_PROBE)) as SceneProbe | null;
      lastError = undefined;
    } catch (error) {
      lastError = (error as Error).message;
    }

    if (last?.hasScene && (last.meshes ?? 0) > 0 && Date.now() - startedAt >= PLAY_MIN_SETTLE_MS) {
      break;
    }
  }

  return last ? { probe: last } : { probe: null, error: lastError };
}

/**
 * The fixed game check (D8): typecheck, load the landing page, optionally enter `/play` with the
 * given GameMode, probe the scene, screenshot it, and put the preview back where it was.
 */
export async function runGameCheck(params: WorkspaceCheckParams): Promise<GameCheckResult> {
  const gameMode = typeof params?.gameMode === 'string' && params.gameMode.trim() ? params.gameMode.trim() : undefined;
  const sceneUrl = typeof params?.sceneUrl === 'string' && params.sceneUrl.trim() ? params.sceneUrl.trim() : undefined;

  const verdict = await runTypecheck();

  const result: GameCheckResult = {
    ok: false,
    typecheck: verdict.value,
    ...(verdict.reason ? { typecheckReason: verdict.reason } : {}),
    home: { errors: [] },
    play: null,
    screenshot: null,
  };

  const noPreview = (): GameCheckResult => {
    requestPreviewReload();
    return { ...result, ok: false, home: { errors: [NO_PREVIEW_SENTENCE] }, play: null, screenshot: null };
  };

  let previousPath = '/';

  try {
    const path = await evaluateInPreview('location.pathname');

    if (typeof path === 'string' && path.startsWith('/')) {
      previousPath = path;
    }
  } catch (error) {
    if (isNoPreviewError(error)) {
      return noPreview();
    }
  }

  /* Errors this navigation causes go to the check result, never the user-facing alert (`check-window.ts`). */
  beginWorkspaceCheck();

  try {
    let startedAt = Date.now();

    try {
      await navigatePreview('/');
    } catch (error) {
      if (isNoPreviewError(error)) {
        return noPreview();
      }

      result.home.errors = capErrors([(error as Error).message]);

      return finalize(result, gameMode);
    }

    await sleep(HOME_SETTLE_MS);
    result.home.errors = capErrors(await collectErrors(startedAt));

    if (gameMode) {
      const play: NonNullable<GameCheckResult['play']> = { errors: [], hasScene: false, meshes: 0, ready: false };
      result.play = play;

      startedAt = Date.now();

      try {
        const navState = { gameMode, ...(sceneUrl ? { sceneUrl } : {}) };

        await navigatePreview('/play', navState);

        const polled = await pollForScene(navState);
        const errors = await collectErrors(startedAt);

        if (polled.probe) {
          play.hasScene = !!polled.probe.hasScene;
          play.meshes = typeof polled.probe.meshes === 'number' ? polled.probe.meshes : 0;
          play.ready = !!polled.probe.ready;
        } else if (polled.error) {
          errors.push(`The scene probe failed: ${polled.error}`);
        }

        play.errors = capErrors(errors);

        try {
          result.screenshot = toScreenshot(await capturePreviewScreenshot());
        } catch {
          result.screenshot = null;
        }
      } catch (error) {
        play.errors = capErrors([(error as Error).message]);
      }
    }

    return finalize(result, gameMode);
  } finally {
    try {
      await navigatePreview(previousPath);
    } catch {
      // Best effort: the check's verdict does not depend on where the preview ends up.
    } finally {
      endWorkspaceCheck();
    }
  }
}

function finalize(result: GameCheckResult, gameMode: string | undefined): GameCheckResult {
  const typecheckOk = result.typecheck === 'unavailable' || result.typecheck.ok;
  const playOk = !gameMode || (!!result.play && result.play.errors.length === 0 && result.play.hasScene);

  result.ok = typecheckOk && result.home.errors.length === 0 && playOk;

  return result;
}

/** Execute one relayed workspace operation. Never throws: a failure is `{ error }`. */
export async function runWorkspaceToolCall(part: WorkspaceToolCallPart): Promise<{ result?: unknown; error?: string }> {
  try {
    const params = (part?.params ?? {}) as Record<string, unknown>;

    switch (part?.op) {
      case 'write': {
        if (typeof params.path !== 'string' || !params.path.trim() || typeof params.content !== 'string') {
          return { error: 'A write needs a path and text content.' };
        }

        await workbenchStore.writeAgentFile(params.path, params.content);

        return { result: { ok: true } };
      }
      case 'run': {
        if (typeof params.command !== 'string' || !params.command.trim()) {
          return { error: 'A command is required.' };
        }

        return { result: await runCommand(params.command, WORKSPACE_RUN_TIMEOUT_MS) };
      }
      case 'check': {
        return { result: await runGameCheck(params as WorkspaceCheckParams) };
      }
      default:
        return { error: `Unknown workspace operation: ${String(part?.op)}` };
    }
  } catch (error) {
    return { error: (error as Error)?.message || String(error) };
  }
}

if (import.meta.env?.DEV && typeof window !== 'undefined') {
  (window as any).__btWorkspace = { runGameCheck, runCommand };
}
