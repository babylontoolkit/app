/**
 * THE DEV-TOOLS TOOLS — and the screenshot path, which fails in a uniquely misleading way.
 *
 * A tool result is TEXT by default. That is fine for `evaluate_in_game` and actively destructive for a
 * screenshot, in two ways that both end with the model reporting a healthy game as broken:
 *
 *   1. **Clipped as text**, a base64 frame becomes a truncated payload that decodes to nothing.
 *   2. **Returned as text at all**, the model receives a string it can describe but cannot LOOK at.
 *
 * So the two properties worth pinning are: the character clip never touches an image, and the tool
 * hands back a real vision part. Neither is visible in a passing generation — a broken image looks
 * exactly like a broken game.
 */
import { describe, expect, it } from 'vitest';
import { createPreviewTools, MAX_PREVIEW_RESULT_CHARS, MAX_SCREENSHOT_BASE64 } from './preview-tools';
import { deliverClientToolResult } from './mcp-relay';

/** Drive one tool: emit is captured, and the "client" answers immediately with `answer`. */
async function callTool(name: string, args: Record<string, unknown>, answer: unknown) {
  const emitted: Array<{ toolCallId: string; method: string }> = [];
  const tools = createPreviewTools({
    generationId: 'gen_1',
    userId: 'u1',
    emit: (event) => {
      emitted.push(event);

      /* The browser's reply, delivered on the next tick exactly as `/api/agent/tool-result` would. */
      setTimeout(
        () =>
          deliverClientToolResult({
            generationId: 'gen_1',
            toolCallId: event.toolCallId,
            userId: 'u1',
            result: answer,
          }),
        0,
      );
    },
  });

  const tool = tools[name] as unknown as {
    execute: (a: unknown, o: unknown) => Promise<unknown>;
    experimental_toToolResultContent?: (r: unknown) => unknown;
  };

  const result = await tool.execute(args, { toolCallId: 'call_1', abortSignal: undefined });

  return { result, emitted, tool };
}

const frame = (base64: string) => ({
  base64,
  mimeType: 'image/jpeg',
  width: 1024,
  height: 576,
  capturedDuringRender: true,
  blank: false,
});

describe('evaluate_in_game', () => {
  it('sends the expression and returns the value', async () => {
    const { result, emitted } = await callTool(
      'evaluate_in_game',
      { expression: 'scene.meshes.length' },
      { value: 42 },
    );

    expect(emitted[0].method).toBe('evaluate');
    expect(result).toEqual({ value: 42 });
  });

  /* Validated in `execute`, never in the schema — a zod rejection kills a generation already paid for. */
  it('refuses an empty expression with a sentence instead of throwing', async () => {
    const tools = createPreviewTools({ generationId: 'g', userId: 'u', emit: () => {} });
    const tool = tools.evaluate_in_game as unknown as { execute: (a: unknown, o: unknown) => Promise<unknown> };

    await expect(tool.execute({ expression: '  ' }, { toolCallId: 'c' })).resolves.toContain('needs an "expression"');
  });

  /* A huge answer is clipped — and the clip ANNOUNCES itself, or the model reads it as the whole value. */
  it('clips an oversized text answer and says so', async () => {
    const { result } = await callTool(
      'evaluate_in_game',
      { expression: 'dump()' },
      'z'.repeat(MAX_PREVIEW_RESULT_CHARS + 5_000),
    );

    expect(String(result)).toContain('truncated');
  });
});

describe('capture_game_screenshot', () => {
  /*
   * 🔴 The clip must NOT apply here. A base64 frame is far past the text ceiling, and truncating it
   * yields an image that decodes to nothing — which the model reports as "the game renders nothing".
   */
  it('does not clip the image payload as text', async () => {
    const base64 = 'A'.repeat(MAX_PREVIEW_RESULT_CHARS + 50_000);
    const { result } = await callTool('capture_game_screenshot', {}, frame(base64));

    expect((result as { base64: string }).base64).toHaveLength(base64.length);
    expect(JSON.stringify(result)).not.toContain('truncated');
  });

  /* 🔴 Whole or nothing. Half an image is worse than none — it looks like evidence. */
  it('refuses an oversized frame outright rather than truncating it', async () => {
    const { result } = await callTool('capture_game_screenshot', {}, frame('A'.repeat(MAX_SCREENSHOT_BASE64 + 10)));
    const shot = result as { base64?: string; note?: string };

    expect(shot.base64).toBeUndefined();
    expect(shot.note).toContain('too large');
  });

  it('reports a missing frame as a sentence, not an empty image', async () => {
    const { result } = await callTool('capture_game_screenshot', {}, { base64: null, blank: true });

    expect((result as { note?: string }).note).toBeTruthy();
  });
});

describe('the screenshot reaches the model as an IMAGE', () => {
  /*
   * 🔴 Without `experimental_toToolResultContent` the model gets a base64 STRING — it can describe the
   * string and cannot see the picture, while every test about capturing still passes.
   */
  it('returns a vision part alongside the summary text', async () => {
    const { tool } = await callTool('capture_game_screenshot', {}, frame('AAAA'));
    const content = tool.experimental_toToolResultContent?.(frame('AAAA')) as Array<Record<string, unknown>>;

    expect(content[0]).toEqual({ type: 'image', data: 'AAAA', mimeType: 'image/jpeg' });
    expect(content.some((part) => part.type === 'text')).toBe(true);
  });

  /* The caveat has to be READABLE, or a blank picture gets filed as a broken game. */
  it('carries the blank-frame note in the text part', async () => {
    const { tool } = await callTool('capture_game_screenshot', {}, frame('AAAA'));
    const content = tool.experimental_toToolResultContent?.({
      base64: null,
      blank: true,
      note: 'The captured frame is blank',
    }) as Array<Record<string, unknown>>;

    expect(content).toHaveLength(1);
    expect(String(content[0].text)).toContain('blank');
  });

  /* CONTROL — a real frame is not silently downgraded to text-only. */
  it('CONTROL: a healthy frame still yields an image part', async () => {
    const { tool } = await callTool('capture_game_screenshot', {}, frame('AAAA'));
    const content = tool.experimental_toToolResultContent?.(frame('BBBB')) as Array<Record<string, unknown>>;

    expect(content.some((part) => part.type === 'image')).toBe(true);
  });
});
