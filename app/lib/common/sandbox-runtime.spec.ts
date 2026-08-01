/**
 * The provider-traits table and the id resolver.
 *
 * This is a small file guarding a large blast radius: these three booleans decide whether the app
 * tells users their files are safe, whether a boot demands a project id, and whether the server sends
 * cross-origin-isolation headers. Each was previously a `=== 'codesandbox'` comparison that a new
 * provider would have inherited silently.
 */
import { describe, expect, it } from 'vitest';
import { WORK_DIR } from '~/utils/constants';
import { SANDBOX_ROOTS, toProjectRelativePath } from './sandbox-paths';
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

      expect(Object.keys(traits).sort()).toEqual([
        'needsCrossOriginIsolation',
        'outlivesSession',
        'requiresProject',
        'workdir',
      ]);

      const { workdir, ...flags } = traits;
      expect(typeof workdir).toBe('string');

      for (const value of Object.values(flags)) {
        expect(typeof value).toBe('boolean');
      }
    }
  });

  it.each<[SandboxProviderId, string, boolean, boolean, boolean]>([
    // id, workdir, outlivesSession, requiresProject, needsCrossOriginIsolation
    ['nodepod', '/home/project', false, false, true],
    ['webcontainer', '/home/project', false, false, true],
    ['codesandbox', '/project/workspace', true, true, false],
  ])('pins %s exactly', (id, workdir, outlivesSession, requiresProject, needsCrossOriginIsolation) => {
    expect(SANDBOX_PROVIDER_TRAITS[id]).toEqual({
      workdir,
      outlivesSession,
      requiresProject,
      needsCrossOriginIsolation,
    });
  });

  /*
   * ⚠️ THE AGREEMENT THAT WAS ONLY EVER A COMMENT. `constants.ts` said "it must agree with
   * SANDBOX_ROOTS ... adding a provider means touching both", and nothing checked. `SANDBOX_ROOTS`
   * recognises the roots of OTHER providers too, because a working copy outlives the provider that
   * wrote it — so a root missing from that list does not throw, it leaves paths absolute and they
   * fail later, somewhere that does not mention paths at all.
   */
  it('puts every provider workdir in SANDBOX_ROOTS, which strips them', () => {
    for (const id of SANDBOX_PROVIDER_IDS) {
      const { workdir } = SANDBOX_PROVIDER_TRAITS[id];

      expect(SANDBOX_ROOTS).toContain(workdir);
      expect(toProjectRelativePath(`${workdir}/src/main.tsx`)).toBe('src/main.tsx');
    }
  });

  /*
   * WORK_DIR is what the workbench renders as its root folder and what six module-scope call sites
   * read. It must BE the resolved provider's workdir — the bug this replaced computed it with a
   * `=== 'codesandbox'` comparison, which silently handed every future provider `/home/project`.
   */
  it('is the source of WORK_DIR for the build this test runs in', () => {
    expect(SANDBOX_ROOTS).toContain(WORK_DIR);
    expect(Object.values(SANDBOX_PROVIDER_TRAITS).map((t) => t.workdir)).toContain(WORK_DIR);
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
