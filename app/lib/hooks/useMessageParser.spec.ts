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
