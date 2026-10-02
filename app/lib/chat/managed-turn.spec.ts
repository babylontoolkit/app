/**
 * The browser's half of managed-engine reconnect and Stop (`managed-turn.ts`, T6). Each function is a
 * no-op on the legacy engine — the CONTROL in every case.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  managedTurnStatus,
  requestManagedInterrupt,
  RESUME_PLACEHOLDER,
  resumeAction,
  whenReady,
  withManagedChatId,
} from './managed-turn';

const id = { projectId: 'prj_1', chatId: '6d3f2b8a-1c2d-4e5f-8a9b-0c1d2e3f4a5b' };

describe('requestManagedInterrupt', () => {
  it('POSTs the interrupt with keepalive on the managed engine — and never on legacy', () => {
    const fetchImpl = vi.fn(async () => new Response('{}'));

    expect(requestManagedInterrupt('managed', id, fetchImpl as unknown as typeof fetch)).toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith(
      '/api/agent/managed/interrupt',
      expect.objectContaining({ method: 'POST', keepalive: true, body: JSON.stringify(id) }),
    );

    fetchImpl.mockClear();
    expect(requestManagedInterrupt('legacy', id, fetchImpl as unknown as typeof fetch)).toBe(false);
    expect(requestManagedInterrupt('managed', { projectId: 'prj_1' }, fetchImpl as unknown as typeof fetch)).toBe(
      false,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('a failing network never throws out of Stop', () => {
    const fetchImpl = vi.fn(() => Promise.reject(new Error('offline')));

    expect(() => requestManagedInterrupt('managed', id, fetchImpl as unknown as typeof fetch)).not.toThrow();
  });
});

describe('managedTurnStatus', () => {
  it('pending (with the turn’s text) only for a managed engine answer of pending:true; not on errors or legacy', async () => {
    const answer = (body: unknown, ok = true) =>
      vi.fn(async () => new Response(JSON.stringify(body), { status: ok ? 200 : 404 }));
    const status = (body: unknown, ok = true) =>
      managedTurnStatus('managed', id, answer(body, ok) as unknown as typeof fetch);

    expect(await status({ engine: 'managed', pending: true, userText: 'make it drift' })).toEqual({
      pending: true,
      userText: 'make it drift',
    });
    expect(await status({ engine: 'managed', pending: false })).toEqual({ pending: false });
    expect(await status({ message: 'Chat not found.' }, false)).toEqual({ pending: false });

    const never = vi.fn();

    expect(await managedTurnStatus('legacy', id, never as unknown as typeof fetch)).toEqual({ pending: false });
    expect(never).not.toHaveBeenCalled();
  });
});

describe('resumeAction', () => {
  it('reloads when the transcript already ends with the turn’s user message', () => {
    expect(resumeAction('user', 'x')).toEqual({ kind: 'reload' });
  });

  it('APPENDS when it ends with an assistant message — reload would drop the previous answer', () => {
    expect(resumeAction('assistant', 'make it drift')).toEqual({ kind: 'append', content: 'make it drift' });
    expect(resumeAction('assistant', undefined)).toEqual({ kind: 'append', content: RESUME_PLACEHOLDER });
    expect(resumeAction(undefined, undefined)).toEqual({ kind: 'append', content: RESUME_PLACEHOLDER });
  });
});

describe('withManagedChatId', () => {
  it('mints a chat id only on the managed engine, only for a project turn that has none', () => {
    const mint = vi.fn(() => 'minted');

    expect(withManagedChatId('managed', { projectId: 'prj_1' }, mint)).toEqual({
      projectId: 'prj_1',
      chatId: 'minted',
    });
    expect(withManagedChatId('managed', id, mint)).toBe(id);
    expect(withManagedChatId('legacy', { projectId: 'prj_1' }, mint)).toEqual({ projectId: 'prj_1' });
    expect(withManagedChatId('managed', {}, mint)).toEqual({});
    expect(mint).toHaveBeenCalledTimes(1);
  });
});

describe('whenReady', () => {
  it('resolves at once when ready, on the first notification that makes it ready, and false on timeout', async () => {
    expect(
      await whenReady(
        () => true,
        () => () => undefined,
      ),
    ).toBe(true);

    let ready = false;
    let notify: () => void = () => undefined;
    const pending = whenReady(
      () => ready,
      (onChange) => {
        notify = onChange;
        return () => undefined;
      },
      5000,
    );

    notify(); // not ready yet — keeps waiting
    ready = true;
    notify();
    expect(await pending).toBe(true);

    expect(
      await whenReady(
        () => false,
        () => () => undefined,
        10,
      ),
    ).toBe(false);
  });
});
