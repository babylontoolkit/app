/**
 * The provider-traits table and the id resolver.
 *
 * This is a small file guarding a large blast radius: these three booleans decide whether the app
 * tells users their files are safe, whether a boot demands a project id, and whether the server sends
 * cross-origin-isolation headers. Each was previously a `=== 'codesandbox'` comparison that a new
 * provider would have inherited silently.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SANDBOX_PROVIDER,
  SANDBOX_PROVIDER_IDS,
  SANDBOX_PROVIDER_TRAITS,
  resolveSandboxProviderId,
  type SandboxProviderId,
} from './sandbox-runtime';

describe('the default provider', () => {
  /*
   * 🔴 The default is a MONEY decision, not a preference. WebContainers is ~$10,000 per 8,000 API
   * calls and CodeSandbox bills per VM-hour; Nodepod needs no credential and no VM. An unset or
   * mistyped variable must never land on a paid runtime.
   */
  it('is nodepod', () => {
    expect(DEFAULT_SANDBOX_PROVIDER).toBe('nodepod');
  });

  it('is what an unset variable resolves to', () => {
    expect(resolveSandboxProviderId(undefined)).toBe('nodepod');
    expect(resolveSandboxProviderId('')).toBe('nodepod');
  });

  it('is what an unrecognised value falls back to — loudly', () => {
    const warnings: string[] = [];

    expect(resolveSandboxProviderId('webcontainr', (m) => warnings.push(m))).toBe('nodepod');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('webcontainr');
  });

  it('never warns about a value it accepted', () => {
    const warnings: string[] = [];

    for (const id of SANDBOX_PROVIDER_IDS) {
      expect(resolveSandboxProviderId(id, (m) => warnings.push(m))).toBe(id);
    }

    expect(warnings).toEqual([]);
  });

  /* A resolver that throws would take down the server render over a typo in a deploy config. */
  it('never throws, whatever it is handed', () => {
    for (const value of ['', ' ', 'NODEPOD', 'nodepod ', '../x', '{}']) {
      expect(() => resolveSandboxProviderId(value)).not.toThrow();
    }
  });
});

describe('provider traits', () => {
  /* The Record type is the wall; this asserts nobody widened it back to a partial. */
  it('answers every question for every provider', () => {
    for (const id of SANDBOX_PROVIDER_IDS) {
      const traits = SANDBOX_PROVIDER_TRAITS[id];

      expect(Object.keys(traits).sort()).toEqual(['needsCrossOriginIsolation', 'outlivesSession', 'requiresProject']);

      for (const value of Object.values(traits)) {
        expect(typeof value).toBe('boolean');
      }
    }
  });

  it.each<[SandboxProviderId, boolean, boolean, boolean]>([
    // id, outlivesSession, requiresProject, needsCrossOriginIsolation
    ['nodepod', false, false, true],
    ['webcontainer', false, false, true],
    ['codesandbox', true, true, false],
  ])('pins %s exactly', (id, outlivesSession, requiresProject, needsCrossOriginIsolation) => {
    expect(SANDBOX_PROVIDER_TRAITS[id]).toEqual({ outlivesSession, requiresProject, needsCrossOriginIsolation });
  });

  /*
   * The two browser-side runtimes must agree, because the save nudges (§4.5.4b) and the eager-boot
   * path both key off these. If they ever diverge it is a deliberate change, not a typo.
   */
  it('treats the two browser-side runtimes identically', () => {
    expect(SANDBOX_PROVIDER_TRAITS.nodepod).toEqual(SANDBOX_PROVIDER_TRAITS.webcontainer);
  });

  /* A runtime whose files die with the tab cannot also be the project's durable home. */
  it('never claims a session-scoped runtime outlives the session', () => {
    for (const id of SANDBOX_PROVIDER_IDS) {
      const { outlivesSession, requiresProject } = SANDBOX_PROVIDER_TRAITS[id];

      if (requiresProject) {
        expect(outlivesSession).toBe(true);
      }
    }
  });
});
