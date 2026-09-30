import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Message } from 'ai';
import { describe, expect, it } from 'vitest';
import { withFinalMessage } from './final-message';

const user = { id: 'u1', role: 'user', content: 'add a pause menu' } as Message;
const stale = { id: 'a1', role: 'assistant', content: 'Adding a pause state.' } as Message;
const final = {
  id: 'a1',
  role: 'assistant',
  content: 'Adding a pause state.\n\nDone — press Esc to pause.',
  annotations: [{ type: 'agentMeta', value: { generationId: 'g1' } }],
} as unknown as Message;

describe('withFinalMessage', () => {
  it('replaces the mid-stream snapshot of the finished message (the live defect)', () => {
    const out = withFinalMessage([user, stale], final);

    expect(out).toEqual([user, final]);
    expect(out[1].annotations).toHaveLength(1);
  });

  it('appends the finished message when the snapshot never saw it', () => {
    expect(withFinalMessage([user], final)).toEqual([user, final]);
  });

  it('is a no-op without a finished message', () => {
    const messages = [user, stale];
    expect(withFinalMessage(messages, undefined)).toBe(messages);
  });
});

/*
 * The wiring: the pure rule is worthless if `onFinish` stops handing the finished message over, or the
 * checkpoint stops using it — both silent, both restore the stale upload.
 */
describe('withFinalMessage wiring', () => {
  const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8');

  it('onFinish passes the finished message to the checkpoint', () => {
    expect(read('app/components/chat/Chat.client.tsx')).toMatch(
      /checkpointProject\(message\.id, \{ finalMessage: message \}\)/,
    );
  });

  it('the checkpoint lays it over the saved conversation', () => {
    const source = read('app/lib/persistence/useChatHistory.ts');

    expect(source).toMatch(/saveCurrentChat\(pid, options\?\.finalMessage\)/);
    expect(source).toMatch(/latestMessages\.current = withFinalMessage\(latestMessages\.current, finalMessage\)/);
  });
});
