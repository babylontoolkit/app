import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PLAY_SCENE_DEADLINE_MS } from '~/lib/agent/workspace-protocol-types';

const order: string[] = [];

const fakeSandbox = {
  spawn: vi.fn(),
  fs: { readFile: vi.fn(), writeFile: vi.fn(), mkdir: vi.fn() },
};

vi.mock('~/lib/sandbox', () => ({ sandbox: Promise.resolve(fakeSandbox) }));

vi.mock('~/lib/stores/workbench', () => ({
  workbenchStore: {
    writeAgentFile: vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push('write-resolved');
    }),
  },
}));

vi.mock('~/lib/stores/preview-reload', () => ({ requestPreviewReload: vi.fn() }));

vi.mock('~/lib/preview/bridge', () => ({
  evaluateInPreview: vi.fn(),
  readPreviewErrors: vi.fn(),
  capturePreviewScreenshot: vi.fn(),
  isPreviewBridgeReady: vi.fn(() => true),
  notifyPreviewReloading: vi.fn(),
}));

const bridge = await import('~/lib/preview/bridge');
const { requestPreviewReload } = await import('~/lib/stores/preview-reload');
const { workbenchStore } = await import('~/lib/stores/workbench');
const {
  NO_PREVIEW_SENTENCE,
  TIMEOUT_EXIT_CODE,
  TYPECHECK_ARGV,
  parseTypecheckOutput,
  runCommand,
  runGameCheck,
  runWorkspaceToolCall,
} = await import('./executor');

interface FakeProc {
  exit: Promise<number>;
  output: ReadableStream<string>;
  kill: ReturnType<typeof vi.fn>;
}

/** A process that prints `output` and exits with `code` (or never exits when `code` is null). */
function proc(output: string, code: number | null): FakeProc {
  let resolveExit: (value: number) => void = () => undefined;
  const exit = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });
  const stream = new ReadableStream<string>({
    start(controller) {
      if (output) {
        controller.enqueue(output);
      }

      if (code !== null) {
        controller.close();
      }
    },
  });

  if (code !== null) {
    resolveExit(code);
  }

  return { exit, output: stream, kill: vi.fn(() => resolveExit(137)) };
}

const evaluate = vi.mocked(bridge.evaluateInPreview);
const readErrors = vi.mocked(bridge.readPreviewErrors);
const screenshot = vi.mocked(bridge.capturePreviewScreenshot);

/** A healthy preview: pathname `/start`, no errors, a scene with meshes, a screenshot. */
function healthyPreview(overrides: { probe?: () => unknown; homeErrors?: string[]; playErrors?: string[] } = {}) {
  let navigations = 0;
  let path = '/start';

  evaluate.mockImplementation(async (expression: string) => {
    if (expression === 'location.pathname') {
      return path;
    }

    if (expression.includes('location.assign')) {
      navigations++;
      path = /location\.assign\("([^"]+)"\)/.exec(expression)?.[1] ?? path;

      return true;
    }

    if (expression.includes('GetScene')) {
      return overrides.probe ? overrides.probe() : { hasScene: true, meshes: 12, ready: true };
    }

    return undefined;
  });

  readErrors.mockImplementation(async () => {
    // Navigation 1 = home, 2 = play.
    const errors = navigations <= 1 ? (overrides.homeErrors ?? []) : (overrides.playErrors ?? []);
    return errors.map((message) => ({ type: 'error' as const, message, at: Date.now() }));
  });

  screenshot.mockResolvedValue({ base64: 'QUJD', mimeType: 'image/png', width: 1, height: 1, blank: false } as never);
}

/** A real-shaped clean `tsc -b --extendedDiagnostics` run: exit 0, and it READ the project. */
const CLEAN_TSC =
  'Files:                       3558\nLines of TypeScript:         2381\nAggregate Lines of TypeScript:         2646\nBuild time: 3.16s\n';

function tscPasses() {
  fakeSandbox.spawn.mockImplementation(async () => proc(CLEAN_TSC, 0));
}

async function settle<T>(promise: Promise<T>): Promise<T> {
  await vi.runAllTimersAsync();
  return promise;
}

beforeEach(() => {
  order.length = 0;
  vi.clearAllMocks();
  vi.mocked(bridge.isPreviewBridgeReady).mockReturnValue(true);
  fakeSandbox.fs.readFile.mockResolvedValue('{"name":"game"}');
});

afterEach(() => {
  vi.useRealTimers();
});

describe('write op', () => {
  it('awaits writeAgentFile before resolving', async () => {
    const outcome = await runWorkspaceToolCall({
      type: 'workspace-tool-call',
      generationId: 'g',
      toolCallId: 't',
      op: 'write',
      params: { path: 'src/a.ts', content: 'x' },
    }).then((value) => {
      order.push('call-resolved');
      return value;
    });

    expect(outcome).toEqual({ result: { ok: true } });
    expect(workbenchStore.writeAgentFile).toHaveBeenCalledWith('src/a.ts', 'x');
    expect(order).toEqual(['write-resolved', 'call-resolved']);
  });

  it('a failed write is an error, never a result', async () => {
    vi.mocked(workbenchStore.writeAgentFile).mockRejectedValueOnce(new Error('disk full'));

    const outcome = await runWorkspaceToolCall({
      type: 'workspace-tool-call',
      generationId: 'g',
      toolCallId: 't',
      op: 'write',
      params: { path: 'src/a.ts', content: 'x' },
    });

    expect(outcome).toEqual({ error: 'disk full' });
  });
});

describe('run op', () => {
  it('refuses npm run dev', async () => {
    const outcome = await runWorkspaceToolCall({
      type: 'workspace-tool-call',
      generationId: 'g',
      toolCallId: 't',
      op: 'run',
      params: { command: 'npm run dev' },
    });

    expect(outcome.error).toContain('not allowed');
    expect(fakeSandbox.spawn).not.toHaveBeenCalled();
  });

  it('refuses npm run preview and anything off the allow-list', async () => {
    await expect(runCommand('npm run preview', 1000)).rejects.toThrow('not allowed');
    await expect(runCommand('rm -rf /', 1000)).rejects.toThrow('not allowed');
    await expect(runCommand('npm install x && npm run dev', 1000)).rejects.toThrow('not allowed');
    expect(fakeSandbox.spawn).not.toHaveBeenCalled();
  });

  it('npm uninstall is not in the allow-list, so it is refused', async () => {
    await expect(runCommand('npm uninstall x', 1000)).rejects.toThrow('not allowed');
  });

  it('executes && segments in order and stops at first non-zero', async () => {
    fakeSandbox.spawn.mockImplementationOnce(async () => proc('boom\n', 1));

    const result = await runCommand('npm run build && npm run lint', 5000);

    expect(fakeSandbox.spawn).toHaveBeenCalledTimes(1);
    expect(fakeSandbox.spawn).toHaveBeenCalledWith('npm', ['run', 'build']);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('boom');
  });

  it('runs every segment in order when each succeeds', async () => {
    fakeSandbox.spawn.mockImplementation(async (_cmd: string, args: string[]) => proc(`${args.join(' ')}\n`, 0));

    const result = await runCommand('npm install a && npm run build', 5000);

    expect(fakeSandbox.spawn.mock.calls.map((call) => call[1])).toEqual([
      ['install', 'a'],
      ['run', 'build'],
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.output.indexOf('install a')).toBeLessThan(result.output.indexOf('run build'));
  });

  it('times out with exit 124 and kills', async () => {
    vi.useFakeTimers();

    const hung = proc('working…', null);
    fakeSandbox.spawn.mockImplementationOnce(async () => hung);

    const result = await settle(runCommand('npm run build', 1000));

    expect(result.exitCode).toBe(TIMEOUT_EXIT_CODE);
    expect(hung.kill).toHaveBeenCalled();
  });

  it('tail-caps output to 12000', async () => {
    const huge = `${'a'.repeat(30_000)}THE-END`;
    fakeSandbox.spawn.mockImplementationOnce(async () => proc(huge, 0));

    const result = await runCommand('npm run build', 5000);

    expect(result.output.length).toBe(12_000);
    expect(result.output.endsWith('THE-END\n')).toBe(true);
  });

  it('returns packageJson after install', async () => {
    fakeSandbox.spawn.mockImplementationOnce(async () => proc('added 1 package\n', 0));
    fakeSandbox.fs.readFile.mockResolvedValueOnce('{"dependencies":{"x":"1"}}');

    const result = await runCommand('npm install x', 5000);

    expect(result.packageJson).toBe('{"dependencies":{"x":"1"}}');
    expect(fakeSandbox.fs.readFile).toHaveBeenCalledWith('package.json', 'utf-8');
  });

  it('carries no packageJson for a script run', async () => {
    fakeSandbox.spawn.mockImplementationOnce(async () => proc('', 0));

    const result = await runCommand('npm run build', 5000);

    expect(result.packageJson).toBeUndefined();
  });
});

describe('typecheck verdict (non-vacuous by construction)', () => {
  it('a clean exit that read ZERO lines of TypeScript is unavailable, never a pass', () => {
    const vacuous =
      'Files:                          0\nLines of Library:               0\nLines of TypeScript:            0\nTotal time: 0.01s\n';
    const verdict = parseTypecheckOutput(0, vacuous);

    expect(verdict.value).toBe('unavailable');
    expect(verdict.reason).toContain('0 lines of TypeScript');
  });

  it('a clean exit with no diagnostics at all is unavailable', () => {
    const verdict = parseTypecheckOutput(0, '');

    expect(verdict.value).toBe('unavailable');
    expect(verdict.reason).toBeTruthy();
  });

  it('errors are a failing verdict with the error lines', () => {
    const output =
      "src/scripts/__btTypecheckProbe.ts:1:7 - error TS2322: Type 'string' is not assignable to type 'number'.\n\n1 const x: number = 'a';\n\nFound 1 error.\n";

    expect(parseTypecheckOutput(2, output).value).toEqual({
      ok: false,
      errors: [
        "src/scripts/__btTypecheckProbe.ts:1:7 - error TS2322: Type 'string' is not assignable to type 'number'.",
      ],
    });
  });

  it('a clean exit that counted the project is a pass', () => {
    expect(parseTypecheckOutput(0, CLEAN_TSC)).toEqual({ value: { ok: true, errors: [] } });
  });

  it('the check runs tsc in build mode, forced, with diagnostics — never `npx tsc -p` (Nodepod npx eats -p)', async () => {
    vi.useFakeTimers();
    tscPasses();
    healthyPreview();

    const result = await settle(runGameCheck({}));

    expect(fakeSandbox.spawn).toHaveBeenCalledWith('npx', ['tsc', '-b', '--force', '--extendedDiagnostics']);
    expect(TYPECHECK_ARGV).not.toContain('-p');
    expect(result.typecheck).toEqual({ ok: true, errors: [] });
    expect(result.typecheckReason).toBeUndefined();
  });

  it('a vacuous tsc run reaches the check result as unavailable with its reason', async () => {
    vi.useFakeTimers();
    fakeSandbox.spawn.mockImplementation(async () => proc('Files: 0\nLines of TypeScript: 0\n', 0));
    healthyPreview();

    const result = await settle(runGameCheck({}));

    expect(result.typecheck).toBe('unavailable');
    expect(result.typecheckReason).toContain('did not see the project');
  });
});

describe('check op', () => {
  it('ok matrix — a healthy game passes', async () => {
    vi.useFakeTimers();
    tscPasses();
    healthyPreview();

    const result = await settle(runGameCheck({ gameMode: 'KartMode' }));

    expect(result.ok).toBe(true);
    expect(result.typecheck).toEqual({ ok: true, errors: [] });
    expect(result.home.errors).toEqual([]);
    expect(result.play).toEqual({ errors: [], hasScene: true, meshes: 12, ready: true });
    expect(result.screenshot).toEqual({ base64: 'QUJD', mimeType: 'image/png' });
  });

  it('ok matrix — a type error fails the check', async () => {
    vi.useFakeTimers();
    fakeSandbox.spawn.mockImplementation(async () =>
      proc("src/a.ts(1,1): error TS2339: Property 'x' does not exist\n", 2),
    );
    healthyPreview();

    const result = await settle(runGameCheck({ gameMode: 'KartMode' }));

    expect(result.ok).toBe(false);
    expect(result.typecheck).toEqual({
      ok: false,
      errors: ["src/a.ts(1,1): error TS2339: Property 'x' does not exist"],
    });
  });

  it('ok matrix — an unavailable typecheck does not fail the check', async () => {
    vi.useFakeTimers();
    fakeSandbox.spawn.mockRejectedValue(new Error('spawn failed'));
    healthyPreview();

    const result = await settle(runGameCheck({}));

    expect(result.typecheck).toBe('unavailable');
    expect(result.ok).toBe(true);
    expect(result.play).toBeNull();
  });

  it('ok matrix — a home error fails the check', async () => {
    vi.useFakeTimers();
    tscPasses();
    healthyPreview({ homeErrors: ['boom on home'] });

    const result = await settle(runGameCheck({}));

    expect(result.ok).toBe(false);
    expect(result.home.errors).toEqual(['boom on home']);
  });

  it('ok matrix — a play error fails the check', async () => {
    vi.useFakeTimers();
    tscPasses();
    healthyPreview({ playErrors: ['GetKeyDown is not a function'] });

    const result = await settle(runGameCheck({ gameMode: 'KartMode' }));

    expect(result.ok).toBe(false);
    expect(result.play?.errors).toEqual(['GetKeyDown is not a function']);
  });

  it('ok matrix — no scene fails the check', async () => {
    vi.useFakeTimers();
    tscPasses();
    healthyPreview({ probe: () => ({ hasScene: false, meshes: 0, ready: false }) });

    const result = await settle(runGameCheck({ gameMode: 'KartMode' }));

    expect(result.ok).toBe(false);
    expect(result.play?.hasScene).toBe(false);
  });

  it('every expression sent into the preview parses as JavaScript', async () => {
    vi.useFakeTimers();
    tscPasses();
    healthyPreview();

    await settle(runGameCheck({ gameMode: 'KartMode', sceneUrl: 'scenes/a.gltf' }));

    const expressions = evaluate.mock.calls.map((call) => call[0]);
    expect(expressions.some((expression) => expression.includes('LastCreatedScene'))).toBe(true);

    for (const expression of expressions) {
      expect(() => new Function(`return (${expression});`)).not.toThrow();
    }
  });

  it('accepts the legacy dataUrl screenshot shape and drops a blank frame', async () => {
    vi.useFakeTimers();
    tscPasses();
    healthyPreview();
    screenshot.mockResolvedValueOnce({ dataUrl: 'data:image/jpeg;base64,WFla', width: 1, height: 1, blank: false });

    const first = await settle(runGameCheck({ gameMode: 'KartMode' }));
    expect(first.screenshot).toEqual({ base64: 'WFla', mimeType: 'image/jpeg' });

    screenshot.mockResolvedValueOnce({ base64: 'QUJD', mimeType: 'image/jpeg', blank: true } as never);

    const second = await settle(runGameCheck({ gameMode: 'KartMode' }));
    expect(second.screenshot).toBeNull();
  });

  it('seeds the play contract before entering /play', async () => {
    vi.useFakeTimers();
    tscPasses();
    healthyPreview();

    await settle(runGameCheck({ gameMode: 'KartMode', sceneUrl: 'scenes/a.gltf' }));

    const playNav = evaluate.mock.calls
      .map((call) => call[0])
      .find((expression) => expression.includes('location.assign("/play")'));

    expect(playNav).toContain('__bt_nav_state');
    expect(playNav).toContain('KartMode');
    expect(playNav).toContain('scenes/a.gltf');
  });

  it('restores previous path even when the play probe throws', async () => {
    vi.useFakeTimers();
    tscPasses();
    healthyPreview({
      probe: () => {
        throw new Error('globals failed to import');
      },
    });

    const result = await settle(runGameCheck({ gameMode: 'KartMode' }));

    expect(result.ok).toBe(false);
    expect(result.play?.errors.join(' ')).toContain('globals failed to import');

    const navigations = evaluate.mock.calls
      .map((call) => call[0])
      .filter((expression) => expression.includes('location.assign'));
    expect(navigations.at(-1)).toContain('location.assign("/start")');
  });

  it('with no preview returns the restart sentence and calls requestPreviewReload', async () => {
    vi.useFakeTimers();
    tscPasses();
    evaluate.mockRejectedValue(new Error('No preview is running. Start the dev server first.'));

    const result = await settle(runGameCheck({ gameMode: 'KartMode' }));

    expect(result.ok).toBe(false);
    expect(result.home.errors).toEqual([NO_PREVIEW_SENTENCE]);
    expect(result.play).toBeNull();
    expect(requestPreviewReload).toHaveBeenCalled();
  });

  it('a preview that never comes back after navigating is a home error', async () => {
    vi.useFakeTimers();
    tscPasses();
    healthyPreview();
    vi.mocked(bridge.isPreviewBridgeReady).mockReturnValue(false);

    const result = await settle(runGameCheck({}));

    expect(result.ok).toBe(false);
    expect(result.home.errors[0]).toContain('did not come back');
  });
});

describe('check op — the check window (T9 fix loop)', () => {
  it('holds the window open while it navigates the preview, and closes it after — even when the play step throws', async () => {
    const { isWorkspaceCheckInProgress, resetWorkspaceCheckWindow } = await import('./check-window');
    resetWorkspaceCheckWindow();
    vi.useFakeTimers();
    tscPasses();
    healthyPreview({
      probe: () => {
        throw new Error('probe exploded');
      },
    });

    const seen: boolean[] = [];
    const inner = evaluate.getMockImplementation()!;
    evaluate.mockImplementation(async (expression: string) => {
      if (expression.includes('location.assign')) {
        seen.push(isWorkspaceCheckInProgress());
      }

      return inner(expression);
    });

    await settle(runGameCheck({ gameMode: 'KartMode' }));

    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen.every(Boolean)).toBe(true);
    expect(isWorkspaceCheckInProgress()).toBe(false);
  });
});

describe('check op — /play is polled for the scene (T9 fix loop 2)', () => {
  const assigns = () => evaluate.mock.calls.filter(([e]) => String(e).includes('location.assign("/play")')).length;

  it('a scene that appears on the 3rd probe passes', async () => {
    vi.useFakeTimers();
    tscPasses();

    let probes = 0;
    healthyPreview({
      probe: () =>
        ++probes >= 3 ? { hasScene: true, meshes: 40, ready: true } : { hasScene: false, meshes: 0, ready: false },
    });

    const result = await settle(runGameCheck({ gameMode: 'KartMode' }));

    expect(probes).toBeGreaterThanOrEqual(3);
    expect(result.ok).toBe(true);
    expect(result.play).toMatchObject({ hasScene: true, meshes: 40, errors: [] });
    expect(assigns()).toBe(1);
  });

  it('a scene that never appears fails after the deadline (hasScene false)', async () => {
    vi.useFakeTimers();
    tscPasses();

    let probes = 0;
    healthyPreview({
      probe: () => {
        probes++;
        return { hasScene: false, meshes: 0, ready: false };
      },
    });

    const result = await settle(runGameCheck({ gameMode: 'KartMode' }));

    expect(probes).toBeGreaterThan(PLAY_SCENE_DEADLINE_MS / 1000); // polled, not probed once
    expect(result.ok).toBe(false);
    expect(result.play?.hasScene).toBe(false); // the server turns this into "No Babylon scene was created…"
    expect(result.play?.errors).toEqual([]);
  });

  it('a reload that drops the preview off /play mid-poll re-navigates ONCE, then passes', async () => {
    vi.useFakeTimers();
    tscPasses();
    healthyPreview();

    const inner = evaluate.getMockImplementation()!;
    let bounced = false;
    let probes = 0;
    evaluate.mockImplementation(async (expression: string) => {
      if (expression === 'location.pathname' && assigns() === 1 && !bounced) {
        bounced = true; // an HMR full reload landed the preview back on the landing page

        return '/';
      }

      if (expression.includes('GetScene')) {
        probes++;
      }

      return inner(expression);
    });

    const result = await settle(runGameCheck({ gameMode: 'KartMode' }));

    expect(bounced).toBe(true);
    expect(assigns()).toBe(2);
    expect(probes).toBeGreaterThan(0);
    expect(result.ok).toBe(true);
  });
});
