/**
 * Unity Bridge tools (§4.17, D17) — argument handling only; the pipeline itself is `bridge/service.spec.ts`.
 *
 * Every parameter is optional in zod and validated in `execute`: a missing value is a sentence and the
 * pipeline is never reached (so nothing can be debited).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const runBridgeOperation = vi.fn(async (..._args: unknown[]) => 'ran');
const jobControl = vi.fn(async (..._args: unknown[]) => 'job');

vi.mock('~/lib/.server/bridge/service', () => ({
  runBridgeOperation: (...args: unknown[]) => runBridgeOperation(...args),
  jobControl: (...args: unknown[]) => jobControl(...args),
}));

const { createBridgeTools } = await import('./bridge-tools');

type Exec = { execute: (args: unknown, options: unknown) => Promise<unknown> };

const tools = createBridgeTools({
  userId: 'u1',
  projectId: 'p1',
  generationId: 'g1',
  link: { deviceId: 'd1', unityProjectKey: 'k1', unityProjectName: 'Level', allowScripts: false, linkedAt: '' },
  deviceId: 'd1',
  context: {},
  emit: () => undefined,
});

const call = (name: string, args: unknown) =>
  (tools[name] as unknown as Exec).execute(args, { toolCallId: 'call_1', abortSignal: undefined });

beforeEach(() => {
  runBridgeOperation.mockClear();
  jobControl.mockClear();
});

describe('createBridgeTools', () => {
  it('offers the nine bridge tools', () => {
    expect(Object.keys(tools).sort()).toEqual(
      [
        'blender_run_script',
        'bridge_job',
        'unity_capture',
        'unity_cli',
        'unity_command',
        'unity_dev_server',
        'unity_editor',
        'unity_list_commands',
        'unity_run_script',
      ].sort(),
    );
  });

  it('unity_command without a name → a sentence, and the pipeline is never called', async () => {
    expect(await call('unity_command', {})).toMatch(/^unity_command needs name — /);
    expect(runBridgeOperation).not.toHaveBeenCalled();
  });

  it('unity_command with a name → the operation with empty params and its label', async () => {
    expect(await call('unity_command', { name: 'save_all' })).toBe('ran');
    expect(runBridgeOperation).toHaveBeenCalledTimes(1);

    const [op, label, runCtx] = runBridgeOperation.mock.calls[0] as [unknown, string, { toolCallId: string }];
    expect(op).toEqual({ kind: 'unity.command', name: 'save_all', params: {} });
    expect(label).toBe('unity_command save_all');
    expect(runCtx.toolCallId).toBe('call_1');
  });

  it('unity_capture defaults to the game view at 1024x576', async () => {
    await call('unity_capture', {});

    const [op, label] = runBridgeOperation.mock.calls[0] as [unknown, string];
    expect(op).toEqual({ kind: 'unity.capture', view: 'game', width: 1024, height: 576 });
    expect(label).toBe('unity_capture game');
  });

  it('bridge_job without a jobId → a sentence, and jobControl is never called', async () => {
    expect(await call('bridge_job', { action: 'wait' })).toMatch(/^bridge_job needs jobId — /);
    expect(jobControl).not.toHaveBeenCalled();
  });

  it('bridge_job defaults to status with 60 s', async () => {
    await call('bridge_job', { jobId: 'brg_1' });
    expect(jobControl.mock.calls[0].slice(0, 3)).toEqual(['status', 'brg_1', 60]);
  });

  it('unity_cli labels are capped at 160 characters', async () => {
    await call('unity_cli', { args: ['status', 'x'.repeat(400)] });
    expect((runBridgeOperation.mock.calls[0][1] as string).length).toBe(160);
  });

  /* D17: no z.enum / bare z.number in the schemas — a model's "Game" or "800" must never kill the turn. */
  it('unity_capture view "Game" is normalised, and a numeric string width is coerced', async () => {
    await call('unity_capture', { view: 'Game', width: '800' });

    const [op, label] = runBridgeOperation.mock.calls[0] as [unknown, string];
    expect(op).toEqual({ kind: 'unity.capture', view: 'game', width: 800, height: 576 });
    expect(label).toBe('unity_capture game');
  });

  it('unity_editor action "restart" → a sentence naming the choices, and no call', async () => {
    expect(await call('unity_editor', { action: 'restart' })).toBe(
      'unity_editor action must be one of: status, open, close.',
    );
    expect(runBridgeOperation).not.toHaveBeenCalled();
  });

  it('unity_capture with a non-numeric width → a sentence, and no call', async () => {
    expect(await call('unity_capture', { width: 'wide' })).toBe('unity_capture width must be a number.');
    expect(runBridgeOperation).not.toHaveBeenCalled();
  });

  it('bridge_job action "WAIT" and maxSeconds "30" reach jobControl normalised', async () => {
    await call('bridge_job', { action: 'WAIT', jobId: 'brg_1', maxSeconds: '30' });
    expect(jobControl.mock.calls[0].slice(0, 3)).toEqual(['wait', 'brg_1', 30]);
  });

  it('unity_dev_server start with auto "true" and a string port', async () => {
    await call('unity_dev_server', { action: 'Start', port: '8888', auto: 'true' });
    expect(runBridgeOperation.mock.calls[0][0]).toEqual({ kind: 'devserver.start', port: 8888, auto: true });
  });

  it('the schemas accept the loose spellings — the SDK never rejects them before execute', () => {
    const schema = (name: string) =>
      (tools[name] as unknown as { parameters: { safeParse: (v: unknown) => { success: boolean } } }).parameters;

    expect(schema('unity_capture').safeParse({ view: 'Game', width: '1024', height: 576 }).success).toBe(true);
    expect(schema('unity_editor').safeParse({ action: 'restart' }).success).toBe(true);
    expect(schema('unity_dev_server').safeParse({ action: 'START', port: '8888', auto: 'yes' }).success).toBe(true);
    expect(schema('bridge_job').safeParse({ action: 'Wait', jobId: 'x', maxSeconds: '30' }).success).toBe(true);
    expect(schema('blender_run_script').safeParse({ source: 'x', timeoutSeconds: '600' }).success).toBe(true);
  });

  it('unity_command params as a JSON string is parsed; a non-object is a sentence', async () => {
    await call('unity_command', { name: 'set_transform', params: '{"path":"Player"}' });
    expect(runBridgeOperation.mock.calls[0][0]).toEqual({
      kind: 'unity.command',
      name: 'set_transform',
      params: { path: 'Player' },
    });

    expect(await call('unity_command', { name: 'set_transform', params: '[1,2]' })).toMatch(
      /params must be a JSON object/,
    );
    expect(runBridgeOperation).toHaveBeenCalledTimes(1);
  });

  it('unity_cli args as a plain string is split into words', async () => {
    await call('unity_cli', { args: 'projects info' });
    expect(runBridgeOperation.mock.calls[0][0]).toEqual({ kind: 'unity.cli', args: ['projects', 'info'] });
  });
});
