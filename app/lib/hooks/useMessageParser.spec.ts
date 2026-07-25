/**
 * @vitest-environment jsdom
 *
 * A transcript is rendered, never re-run (SPEC §4.5.4b).
 *
 * 🔴 **This is the test that matters, and it is deliberately not a test of `markAsTranscript`.**
 * Marking messages is trivially correct and trivially tested; the CLAIM the whole design rests on is
 * that a marked message reaches the parser and no file gets written. If that claim is false, every
 * project opened on a second device has its repo files silently overwritten with months-old bodies —
 * and every unit test of the mark would still pass.
 *
 * So this drives the real `useMessageParser` with real artifact markup and only the workbench store
 * mocked, and reads what the parser actually did. (The §4.14 MCP relay was "correct by construction"
 * too, right up until a test that read the wire found three defects in it.)
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { Message } from 'ai';

const runAction = vi.fn();
const addAction = vi.fn();
const addCompletedAction = vi.fn();
const addArtifact = vi.fn();
const updateArtifact = vi.fn();

/**
 * 🔴 Hoisted so it can be ASSERTED on. It used to be an anonymous `vi.fn()` inline in the mock below —
 * which meant the test mocked the exact call that was missing from the transcript parser, and no test
 * could see it. The project view vanished for every restored conversation and this file stayed green.
 */
const showWorkbench = vi.fn();

vi.mock('~/lib/stores/workbench', () => ({
  workbenchStore: {
    showWorkbench: { set: (...args: unknown[]) => showWorkbench(...args) },
    addArtifact: (...args: unknown[]) => addArtifact(...args),
    updateArtifact: (...args: unknown[]) => updateArtifact(...args),
    addAction: (...args: unknown[]) => addAction(...args),
    addCompletedAction: (...args: unknown[]) => addCompletedAction(...args),
    runAction: (...args: unknown[]) => runAction(...args),
    actionStreamSampler: vi.fn(),
  },
}));

const { useMessageParser, NO_REPLAY } = await import('./useMessageParser');
const { PLAN_MODE } = await import('~/types/message-marks');

/** A real assistant turn: one artifact, one file write. The shape every generation produces. */
const artifactMessage = (id: string, annotations?: Message['annotations']): Message =>
  ({
    id,
    role: 'assistant',
    annotations,
    content: [
      `<boltArtifact id="racer" title="Racer">`,
      `<boltAction type="file" filePath="src/scripts/RacerMode.ts">export class RacerMode {}</boltAction>`,
      `</boltArtifact>`,
    ].join('\n'),
  }) as Message;

const parse = (messages: Message[]) => {
  const { result } = renderHook(() => useMessageParser());
  act(() => result.current.parseMessages(messages, false));

  return result;
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('an ordinary generation still applies its files', () => {
  /**
   * The control. If this ever fails, the transcript work broke the product's actual job — writing the
   * game — and every other test here would still pass.
   */
  it('runs the actions of an unmarked message', () => {
    parse([artifactMessage('live-1')]);

    expect(runAction).toHaveBeenCalled();
    expect(addAction).toHaveBeenCalled();
  });

  it('opens the workbench', () => {
    parse([artifactMessage('live-2')]);

    expect(showWorkbench).toHaveBeenCalledWith(true);
  });
});

describe('a restored transcript writes nothing', () => {
  it('NEVER runs an action from a marked message', () => {
    parse([artifactMessage('restored-1', [NO_REPLAY])]);

    // The one assertion this file exists for.
    expect(runAction).not.toHaveBeenCalled();
  });

  it('does not queue it as pending work either — it already happened', () => {
    parse([artifactMessage('restored-2', [NO_REPLAY])]);

    expect(addAction).not.toHaveBeenCalled();
    expect(addCompletedAction).toHaveBeenCalled();
  });

  /** Without the artifact the chat renders a bubble that resolves to nothing. Show it; don't do it. */
  it('still shows the artifact, so the conversation reads correctly', () => {
    parse([artifactMessage('restored-3', [NO_REPLAY])]);

    expect(addArtifact).toHaveBeenCalled();
    expect(updateArtifact).toHaveBeenCalled();
  });

  /**
   * 🔴 The reported bug: "where is the project view?"
   *
   * Opening a panel writes no files and re-runs nothing — it is UI, and a restored project deserves
   * the same UI as a live one. This parser dropped it along with `runAction`, which it was right to
   * drop, and the file tree, editor and preview were gone for a project the user was looking at.
   *
   * "Writes nothing" is about the FILESYSTEM. It was never about the screen.
   */
  it('opens the workbench — a restored project is still a project', () => {
    parse([artifactMessage('restored-workbench', [NO_REPLAY])]);

    expect(showWorkbench).toHaveBeenCalledWith(true);
    expect(runAction).not.toHaveBeenCalled();
  });

  it('still returns the rendered content for the message', () => {
    const result = parse([artifactMessage('restored-4', [NO_REPLAY])]);

    expect(result.current.parsedMessages[0]).toContain('__boltArtifact__');
  });

  it('is not confused by other annotations riding along', () => {
    parse([artifactMessage('restored-5', ['no-store', NO_REPLAY, { type: 'chatSummary', summary: 'x' }])]);

    expect(runAction).not.toHaveBeenCalled();
    expect(addCompletedAction).toHaveBeenCalled();
  });
});

describe('plan mode writes ONLY its planning artifacts (§4.2.9)', () => {
  /**
   * A realistic bt-spec turn: the spec file (sanctioned), a source file (a disobedient write the
   * wall must still catch), and a shell command (never run in plan mode).
   */
  const planTurn = (id: string, annotations: Message['annotations']): Message =>
    ({
      id,
      role: 'assistant',
      annotations,
      content: [
        `<boltArtifact id="spec" title="Racing Spec">`,
        `<boltAction type="file" filePath="_specs/racing_spec.md"># Racing Spec</boltAction>`,
        `<boltAction type="file" filePath="src/scripts/RacerMode.ts">export class Hacked {}</boltAction>`,
        `<boltAction type="shell">npm install something</boltAction>`,
        `</boltArtifact>`,
      ].join('\n'),
    }) as Message;

  const ranFilePaths = () => runAction.mock.calls.map((call) => call[0]?.action?.filePath).filter(Boolean);

  it('a LIVE plan turn writes the _specs artifact — the bt-spec/bt-plan bypass', () => {
    const { result } = renderHook(() => useMessageParser());
    act(() => result.current.parseMessages([planTurn('plan-live-1', [NO_REPLAY, PLAN_MODE])], true));

    expect(ranFilePaths()).toContain('_specs/racing_spec.md');
  });

  it('the SAME live plan turn still cannot touch a project file or run a shell command', () => {
    const { result } = renderHook(() => useMessageParser());
    act(() => result.current.parseMessages([planTurn('plan-live-2', [NO_REPLAY, PLAN_MODE])], true));

    expect(ranFilePaths()).not.toContain('src/scripts/RacerMode.ts');

    // The shell action registered as display-only, never executed.
    const ranTypes = runAction.mock.calls.map((call) => call[0]?.action?.type);
    expect(ranTypes).not.toContain('shell');
    expect(addCompletedAction).toHaveBeenCalled();
  });

  /**
   * 🔴 The critical control: a RESTORED plan turn writes NOTHING — not even its _specs file. The
   * user may have hand-edited the spec since; replaying the historical body over it is the
   * §4.5.4b stale-replay bug wearing plan clothes.
   */
  it('a restored plan turn never writes, _specs included', () => {
    parse([planTurn('plan-restored-1', [NO_REPLAY, PLAN_MODE])]);

    expect(runAction).not.toHaveBeenCalled();
    expect(addCompletedAction).toHaveBeenCalled();
  });

  it('a plan message that is not the streaming message stays inert even while loading', () => {
    // An old plan turn on screen while a NEW build generation streams below it.
    const { result } = renderHook(() => useMessageParser());
    act(() =>
      result.current.parseMessages(
        [planTurn('plan-old-1', [NO_REPLAY, PLAN_MODE]), artifactMessage('build-new-1')],
        true,
      ),
    );

    expect(ranFilePaths()).not.toContain('_specs/racing_spec.md');
    expect(ranFilePaths()).toContain('src/scripts/RacerMode.ts'); // the live build message still applies
  });

  /**
   * 🔴 The live failure of 2026-07-24, reproduced: the marks arrive as SEPARATE stream parts before
   * any text, and the 50ms parse sampler can catch the frame where the message carries `NO_REPLAY`
   * but not yet `PLAN_MODE`. Freezing the route off that frame recorded the live plan turn as a
   * restored transcript — the artifact bubble said "Spec written" while the file 404'd on the real
   * filesystem. A route may only freeze once text exists.
   */
  it('does not freeze the route on a marks-only frame — the streaming annotation race', () => {
    const { result } = renderHook(() => useMessageParser());

    // Frame 1: the sampler catches the message annotated but before PLAN_MODE and before any text.
    const early = { ...planTurn('plan-race-1', [NO_REPLAY]), content: '' } as Message;
    act(() => result.current.parseMessages([early], true));

    // Frame 2: all marks and the artifact text have arrived.
    act(() => result.current.parseMessages([planTurn('plan-race-1', [NO_REPLAY, PLAN_MODE])], true));

    expect(ranFilePaths()).toContain('_specs/racing_spec.md');
    expect(ranFilePaths()).not.toContain('src/scripts/RacerMode.ts');
  });

  it('routing is sticky: the finished plan turn does not re-run its write on the next parse pass', () => {
    const message = planTurn('plan-sticky-1', [NO_REPLAY, PLAN_MODE]);
    const { result } = renderHook(() => useMessageParser());

    act(() => result.current.parseMessages([message], true));

    const runsAfterLive = runAction.mock.calls.length;
    expect(ranFilePaths()).toContain('_specs/racing_spec.md');

    // The generation ends; the same message is parsed again with isLoading false.
    act(() => result.current.parseMessages([message], false));

    expect(runAction.mock.calls.length).toBe(runsAfterLive);
  });
});

describe('the two must not bleed into each other', () => {
  /**
   * The realistic shape of the bug: a restored conversation on screen, then the user asks for a
   * change. The old messages must stay inert while the new one applies its files — in the same pass,
   * through the same hook.
   */
  it('replays nothing old while applying the new generation in the same pass', () => {
    parse([artifactMessage('old-1', [NO_REPLAY]), artifactMessage('old-2', [NO_REPLAY]), artifactMessage('new-1')]);

    expect(addCompletedAction).toHaveBeenCalledTimes(2);
    expect(runAction).toHaveBeenCalledTimes(1);

    // The action that ran is the NEW one, not one of the restored ones.
    expect(runAction.mock.calls[0][0].artifactId).toBeDefined();
    expect(addAction).toHaveBeenCalledTimes(1);
  });
});
