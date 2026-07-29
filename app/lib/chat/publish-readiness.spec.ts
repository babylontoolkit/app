/**
 * Publish readiness (T17, found live 2026-07-28).
 *
 * A Share/Deploy click mid-generation built a half-written tree and published it successfully — the
 * guard refuses while the stream or the file actions are still in flight. Only the pure decision is
 * tested here; `publishReadinessNow()` is store wiring by design (see its doc comment).
 */
import { describe, expect, it } from 'vitest';
import { decidePublishReadiness, type ActionLike } from './publish-readiness';

const action = (status: ActionLike['status'], type?: string): ActionLike => ({ status, type });

describe('decidePublishReadiness', () => {
  it('REFUSES while the chat is streaming, and says why', () => {
    const result = decidePublishReadiness({ streaming: true, actions: [] });

    expect(result.ready).toBe(false);
    expect(result.reason).toMatch(/still being built/i);
  });

  it('REFUSES while a file action is still pending', () => {
    const result = decidePublishReadiness({ streaming: false, actions: [action('pending', 'file')] });

    expect(result.ready).toBe(false);
    expect(result.reason).toMatch(/still being written/i);
  });

  it('REFUSES while an action is still running', () => {
    expect(decidePublishReadiness({ streaming: false, actions: [action('running', 'shell')] }).ready).toBe(false);
    expect(decidePublishReadiness({ streaming: false, actions: [action('running')] }).ready).toBe(false);
  });

  /**
   * 🔴 THE STUCK-CLOSED REGRESSION PIN. A dev server's `start` action stays `running` for the whole
   * session BY DESIGN — the first version counted it and refused every publish forever. A running
   * `start` action alone must be READY.
   */
  it('is READY with only a running start action — the dev server must never hold a publish hostage', () => {
    expect(decidePublishReadiness({ streaming: false, actions: [action('running', 'start')] })).toEqual({
      ready: true,
    });
  });

  it('still refuses when real work is pending alongside the dev server', () => {
    const result = decidePublishReadiness({
      streaming: false,
      actions: [action('running', 'start'), action('pending', 'file')],
    });

    expect(result.ready).toBe(false);
  });

  it('is READY once every finishing action has finished — complete, failed, or aborted', () => {
    const result = decidePublishReadiness({
      streaming: false,
      actions: [action('complete', 'file'), action('failed', 'shell'), action('aborted', 'file')],
    });

    expect(result).toEqual({ ready: true });
  });

  it('is READY with no actions at all', () => {
    expect(decidePublishReadiness({ streaming: false, actions: [] })).toEqual({ ready: true });
  });
});
