/**
 * A tool-loop turn the provider breaks mid-turn RESUMES instead of failing (2026-09-30).
 *
 * Measured: 5 of 12 recent turns failed `error+segments:0` after up to 13 billed steps and $5 of
 * provider spend — every one refunded, the user made to start again, while the files those steps
 * wrote were already in the project. `shouldResumeTurn` starts another paid segment without the user
 * asking, so its refusals are pinned; the runner tests drive the real `runToolLoopSegments`.
 */
import type { CoreMessage } from 'ai';
import { describe, expect, it, vi } from 'vitest';
import {
  MAX_TURN_RESUMES,
  RESUME_PROMPT,
  runToolLoopSegments,
  shouldResumeTurn,
  type SegmentFacts,
  type ToolLoopTurnState,
} from './tool-loop';

describe('shouldResumeTurn', () => {
  it('resumes a turn that made progress', () => {
    expect(shouldResumeTurn({ aborted: false, progressed: true, resumesUsed: 0 })).toBe(true);
  });

  it('never resumes a Stop or a closed tab', () => {
    expect(shouldResumeTurn({ aborted: true, progressed: true, resumesUsed: 0 })).toBe(false);
  });

  it('leaves a break before any billed step to the provider retry ladder', () => {
    expect(shouldResumeTurn({ aborted: false, progressed: false, resumesUsed: 0 })).toBe(false);
  });

  it('stops after MAX_TURN_RESUMES', () => {
    expect(shouldResumeTurn({ aborted: false, progressed: true, resumesUsed: MAX_TURN_RESUMES - 1 })).toBe(true);
    expect(shouldResumeTurn({ aborted: false, progressed: true, resumesUsed: MAX_TURN_RESUMES })).toBe(false);
  });
});

type Run = { response: Promise<{ messages: CoreMessage[] }>; ok: boolean; label: string };

const doneFacts = (): Omit<SegmentFacts, 'segmentsRun' | 'nudgesUsed'> => ({
  aborted: false,
  budgetHit: false,
  finishReason: 'stop',
  lastStepToolCalls: 0,
  wroteThisTurn: false,
  lastCheck: null,
  lastWriteSeq: 0,
  breakerTripped: false,
  lastStepInputTokens: 0,
});

function harness(outcomes: boolean[]) {
  const started: Array<{ kind: string; messages: CoreMessage[] }> = [];
  let i = 0;

  const start = (kind: string, messages: CoreMessage[]): Run => {
    started.push({ kind, messages });

    const ok = outcomes[i++] ?? true;

    return { response: Promise.resolve({ messages: [] }), ok, label: kind };
  };

  async function* drain(run: Run): AsyncGenerator<string> {
    yield run.label;

    if (!run.ok) {
      throw new Error('Internal error, please try again later');
    }
  }

  return { started, start, drain };
}

async function collect(gen: AsyncGenerator<string>) {
  const out: string[] = [];

  for await (const chunk of gen) {
    out.push(chunk);
  }

  return out;
}

const cfg = { maxSegments: 6, checkMaxNudges: 3, compactAtTokens: 300_000 };
const summary = () => ({ writes: ['src/scripts/Game.ts'], commands: [], todos: [], lastCheck: null });
const base: CoreMessage[] = [{ role: 'system', content: 'sys' }];

describe('runToolLoopSegments — resuming a broken turn', () => {
  it('resumes from the compact carry when the first segment broke, and finishes', async () => {
    const h = harness([true]);
    const state: ToolLoopTurnState = { segmentsRun: 0, nudgesUsed: 0, stopReason: 'none', resumes: 0 };

    await collect(
      runToolLoopSegments<string, Run>({
        cfg,
        base,
        first: { response: new Promise(() => undefined), ok: false, label: 'first' },
        firstBroke: true,
        state,
        readFacts: doneFacts,
        summary,
        start: h.start,
        drain: h.drain,
      }),
    );

    expect(h.started).toHaveLength(1);

    const resumed = h.started[0].messages.at(-1)!.content as string;
    expect(resumed).toContain(RESUME_PROMPT);
    expect(resumed).toContain('src/scripts/Game.ts');
    expect(state.resumes).toBe(1);
    expect(state.stopReason).toBe('none');
  });

  it('resumes a LATER segment that broke, when the caller allows it', async () => {
    const h = harness([false, true]);
    const state: ToolLoopTurnState = { segmentsRun: 0, nudgesUsed: 0, stopReason: 'none', resumes: 0 };
    const onResume = vi.fn();
    let segment = 0;

    await collect(
      runToolLoopSegments<string, Run>({
        cfg,
        base,
        first: { response: Promise.resolve({ messages: [] }), ok: true, label: 'first' },
        state,

        // After the first segment the model was cut off mid-loop; after that it is done.
        readFacts: () =>
          segment++ === 0 ? { ...doneFacts(), finishReason: 'tool-calls', lastStepToolCalls: 1 } : doneFacts(),
        summary,
        start: h.start,
        drain: h.drain,
        resumable: (_e, used) => used < MAX_TURN_RESUMES,
        onResume,
      }),
    );

    expect(h.started.map((s) => (s.messages.at(-1)!.content as string).includes(RESUME_PROMPT))).toEqual([false, true]);
    expect(onResume).toHaveBeenCalledTimes(1);
    expect(state.resumes).toBe(1);
  });

  it('CONTROL: with no `resumable`, a broken segment still fails the turn', async () => {
    const h = harness([false]);
    const state: ToolLoopTurnState = { segmentsRun: 0, nudgesUsed: 0, stopReason: 'none' };

    await expect(
      collect(
        runToolLoopSegments<string, Run>({
          cfg,
          base,
          first: { response: Promise.resolve({ messages: [] }), ok: true, label: 'first' },
          state,
          readFacts: () => ({ ...doneFacts(), finishReason: 'tool-calls', lastStepToolCalls: 1 }),
          summary,
          start: h.start,
          drain: h.drain,
        }),
      ),
    ).rejects.toThrow(/Internal error/);
  });

  it('fails once the resumes are spent', async () => {
    const h = harness([false, false, false, false]);
    const state: ToolLoopTurnState = { segmentsRun: 0, nudgesUsed: 0, stopReason: 'none', resumes: 0 };

    await expect(
      collect(
        runToolLoopSegments<string, Run>({
          cfg,
          base,
          first: { response: Promise.resolve({ messages: [] }), ok: true, label: 'first' },
          state,
          readFacts: () => ({ ...doneFacts(), finishReason: 'tool-calls', lastStepToolCalls: 1 }),
          summary,
          start: h.start,
          drain: h.drain,
          resumable: (_e, used) => shouldResumeTurn({ aborted: false, progressed: true, resumesUsed: used }),
        }),
      ),
    ).rejects.toThrow(/Internal error/);

    expect(state.resumes).toBe(MAX_TURN_RESUMES);
    expect(h.started).toHaveLength(MAX_TURN_RESUMES + 1);
  });

  it('a resume still respects the segment cap', async () => {
    const h = harness([]);
    const state: ToolLoopTurnState = { segmentsRun: 5, nudgesUsed: 0, stopReason: 'none', resumes: 0 };

    await collect(
      runToolLoopSegments<string, Run>({
        cfg,
        base,
        first: { response: new Promise(() => undefined), ok: false, label: 'first' },
        firstBroke: true,
        state,
        readFacts: doneFacts,
        summary,
        start: h.start,
        drain: h.drain,
      }),
    );

    expect(h.started).toHaveLength(0);
    expect(state.stopReason).toBe('segments');
  });
});
