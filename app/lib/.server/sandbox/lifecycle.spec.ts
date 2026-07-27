/**
 * "Create or resume?" is a decision that can destroy a user's game silently (SPEC §8).
 *
 * Exhaustive, in the shape of `auto-repair.spec.ts` and `restore-target.spec.ts`, because the wrong
 * answer here does not throw: creating when we should have resumed boots a perfect, working sandbox
 * containing a FRESH TEMPLATE instead of the project the user spent credits on, and abandons the old
 * VM to bill until its idle timeout.
 */
import { describe, expect, it } from 'vitest';
import { decideSandboxStart, isDestructive } from './lifecycle';

describe('decideSandboxStart', () => {
  it('creates when the project has never had a sandbox', () => {
    expect(decideSandboxStart({})).toEqual({ action: 'create', reason: 'no-sandbox-yet' });
  });

  it('resumes when the sandbox is confirmed present', () => {
    expect(decideSandboxStart({ recordedSandboxId: 'abc123', existsAtProvider: true })).toEqual({
      action: 'resume',
      reason: 'has-sandbox',
    });
  });

  it('creates when the sandbox is confirmed GONE', () => {
    expect(decideSandboxStart({ recordedSandboxId: 'abc123', existsAtProvider: false })).toEqual({
      action: 'create',
      reason: 'sandbox-gone',
    });
  });

  it('🔴 REFUSES when it could not find out whether the sandbox exists', () => {
    /*
     * The case the whole module exists for. `undefined` is "the network failed", NOT "it is gone".
     * Collapsing the two lets a blip replace someone's project with a template — the same
     * `null`-vs-`undefined` distinction `mount-source.ts` draws to stop a flaky connection deciding
     * the browser is authoritative.
     */
    expect(decideSandboxStart({ recordedSandboxId: 'abc123' })).toEqual({
      action: 'refuse',
      reason: 'existence-unknown',
    });
    expect(decideSandboxStart({ recordedSandboxId: 'abc123', existsAtProvider: undefined })).toEqual({
      action: 'refuse',
      reason: 'existence-unknown',
    });
  });

  it('honours an explicit reset even when the sandbox is alive and reachable', () => {
    expect(decideSandboxStart({ recordedSandboxId: 'abc123', existsAtProvider: true, resetRequested: true })).toEqual({
      action: 'create',
      reason: 'reset-requested',
    });
  });

  it('honours an explicit reset even when existence is unknown', () => {
    // Intent outranks facts: a user asking for a clean environment gets one regardless.
    expect(decideSandboxStart({ recordedSandboxId: 'abc123', resetRequested: true })).toEqual({
      action: 'create',
      reason: 'reset-requested',
    });
  });

  it('never resumes without a recorded id, whatever else is true', () => {
    /*
     * Property rather than an example: there is nothing to resume without an id, and a `resume`
     * here would call the provider with `undefined` and fail in a way that reads as an outage.
     */
    for (const existsAtProvider of [true, false, undefined]) {
      for (const resetRequested of [true, false, undefined]) {
        expect(decideSandboxStart({ existsAtProvider, resetRequested }).action).not.toBe('resume');
      }
    }
  });

  it('never creates while a sandbox is confirmed alive unless a reset was asked for', () => {
    // The expensive mistake, stated as a property: a live sandbox is never discarded by accident.
    expect(decideSandboxStart({ recordedSandboxId: 'x', existsAtProvider: true }).action).toBe('resume');
  });
});

describe('isDestructive', () => {
  it('flags only the create that replaces an existing project', () => {
    expect(isDestructive({ action: 'create', reason: 'sandbox-gone' })).toBe(true);
  });

  it('does not flag a first-ever create, which overwrites nothing', () => {
    expect(isDestructive({ action: 'create', reason: 'no-sandbox-yet' })).toBe(false);
  });

  it('does not flag a reset the user explicitly asked for', () => {
    expect(isDestructive({ action: 'create', reason: 'reset-requested' })).toBe(false);
  });

  it('does not flag resume or refuse', () => {
    expect(isDestructive({ action: 'resume', reason: 'has-sandbox' })).toBe(false);
    expect(isDestructive({ action: 'refuse', reason: 'existence-unknown' })).toBe(false);
  });
});
