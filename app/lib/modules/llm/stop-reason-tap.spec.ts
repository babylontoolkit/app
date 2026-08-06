/**
 * Pins the stop-reason-tap extractor (see stop-reason-tap.ts for why the tap exists at all).
 *
 * The properties that matter: a reason split across two network chunks is still seen exactly once
 * (the overlap re-scan must not double-count), `"stop_reason":null` never matches, and a refusal's
 * `stop_details` rides along with the reason.
 */
import { describe, expect, it } from 'vitest';
import { extractStopReasons } from './stop-reason-tap';

const DELTA = (reason: string) =>
  `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"${reason}","stop_sequence":null},"usage":{"output_tokens":4}}\n\n`;

describe('extractStopReasons', () => {
  it('finds a stop_reason in a message_delta event', () => {
    expect(extractStopReasons(DELTA('end_turn'))).toEqual([{ stopReason: 'end_turn' }]);
  });

  it('finds the unmapped reasons the SDK collapses into unknown', () => {
    expect(extractStopReasons(DELTA('pause_turn'))).toEqual([{ stopReason: 'pause_turn' }]);
    expect(extractStopReasons(DELTA('refusal'))[0]?.stopReason).toBe('refusal');
  });

  it('ignores the null stop_reason message_start carries', () => {
    expect(extractStopReasons('{"message":{"stop_reason":null,"usage":{}}}')).toEqual([]);
  });

  it('carries stop_details alongside a refusal', () => {
    const text = '{"delta":{"stop_reason":"refusal"},"stop_details":{"type":"refusal","category":"cyber"}}';
    expect(extractStopReasons(text)).toEqual([
      { stopReason: 'refusal', detail: '{"type":"refusal","category":"cyber"}' },
    ]);
  });

  it('does not double-count a match that sat fully inside the previous overlap window', () => {
    const chunk = DELTA('pause_turn');

    // First scan sees it; the re-scan passes the overlap length as minEndIndex and must not.
    expect(extractStopReasons(chunk, 0)).toHaveLength(1);
    expect(extractStopReasons(chunk, chunk.length)).toHaveLength(0);
  });

  it('still counts a match that STRADDLES the overlap boundary (ends beyond minEndIndex)', () => {
    const chunk = DELTA('pause_turn');
    const split = chunk.indexOf('pause_turn') + 4; // boundary lands mid-value

    expect(extractStopReasons(chunk, split)).toHaveLength(1);
  });
});
