/**
 * The watchdog's input, pinned (§4.2a, §4.12).
 *
 * These are money tests, not formatting tests: the watchdog's terminal action is `stop()` on a
 * generation the user is paying for, so a size that fails to move during a legitimate thinking phase
 * cancels healthy work and bills for it.
 */
import { describe, expect, it } from 'vitest';
import { streamActivitySize, type ActivityMessage } from './stream-activity';

describe('streamActivitySize', () => {
  it('counts assistant text', () => {
    const messages: ActivityMessage[] = [{ content: 'hello' }];
    expect(streamActivitySize(messages, 0)).toBe(5);
  });

  /*
   * THE REGRESSION. Reasoning rides `parts` (§4.2a — it must never reach the artifact parser), so the
   * old `content`-only sum read a hard-thinking generation as totally silent and cancelled it at 300s.
   */
  it('counts reasoning — a thinking model is NOT a stalled model', () => {
    const thinking: ActivityMessage[] = [
      { content: '', parts: [{ type: 'reasoning', reasoning: 'planning the layout' }] },
    ];

    expect(streamActivitySize(thinking, 0)).toBeGreaterThan(0);
  });

  it('moves as reasoning grows, with no text at all', () => {
    const at10s: ActivityMessage[] = [{ content: '', parts: [{ type: 'reasoning', reasoning: 'a'.repeat(100) }] }];
    const at60s: ActivityMessage[] = [{ content: '', parts: [{ type: 'reasoning', reasoning: 'a'.repeat(4000) }] }];

    expect(streamActivitySize(at60s, 0)).toBeGreaterThan(streamActivitySize(at10s, 0));
  });

  /*
   * A media turn's step 1 is nothing but `generate_image` calls — no prose, no reasoning once the
   * calls start. The state transition is the only sign of life.
   */
  it('counts a tool-invocation state transition as activity (§4.16 media turns)', () => {
    const calling: ActivityMessage[] = [
      { content: '', parts: [{ type: 'tool-invocation', toolInvocation: { state: 'call' } }] },
    ];
    const resulted: ActivityMessage[] = [
      { content: '', parts: [{ type: 'tool-invocation', toolInvocation: { state: 'result' } }] },
    ];

    expect(streamActivitySize(calling, 0)).toBeGreaterThan(0);
    expect(streamActivitySize(resulted, 0)).not.toBe(streamActivitySize(calling, 0));
  });

  it('counts data parts (the media-task channel)', () => {
    expect(streamActivitySize([], 3)).toBe(3);
  });

  it('survives malformed parts rather than throwing inside a timer', () => {
    const junk = [{ content: 1, parts: 'not-an-array' }, { parts: [null, 7, {}] }] as unknown as ActivityMessage[];

    expect(() => streamActivitySize(junk, 0)).not.toThrow();
    expect(streamActivitySize(junk, 0)).toBe(0);
  });

  /* A control: a genuinely dead stream must still read as silent, or the watchdog stops working. */
  it('does NOT move when nothing streams', () => {
    const before: ActivityMessage[] = [{ content: 'hi', parts: [{ type: 'reasoning', reasoning: 'abc' }] }];
    const after: ActivityMessage[] = [{ content: 'hi', parts: [{ type: 'reasoning', reasoning: 'abc' }] }];

    expect(streamActivitySize(after, 0)).toBe(streamActivitySize(before, 0));
  });
});
