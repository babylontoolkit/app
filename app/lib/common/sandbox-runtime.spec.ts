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
  ENABLED_SANDBOX_PROVIDERS,
  SANDBOX_PROVIDER_IDS,
  SANDBOX_PROVIDER_TRAITS,
  isSandboxProviderEnabled,
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

    for (const id of ENABLED_SANDBOX_PROVIDERS) {
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

/**
 * 🔴 The disable wall (owner decision, 2026-07-31).
 *
 * WebContainers is proprietary and commercially licensed (`spec/licensing.md`) and CodeSandbox bills
 * per VM-hour, so on a paid platform neither may be reachable BY CONFIGURATION — a stale `.env`, an
 * old Docker build arg or a CI variable copied from another project must not be able to start one.
 * The failure is silent by nature: a WebContainer build works perfectly, which is precisely why "it
 * is not the default" was never sufficient.
 *
 * These tests exist to make re-enabling a REVIEWED act. Turning one back on for debugging is a
 * supported workflow — it just has to break CI on the way through, so it cannot ride along in a
 * commit that was about something else.
 */
describe('the enabled-provider wall', () => {
  it('allows nodepod and nothing else', () => {
    expect([...ENABLED_SANDBOX_PROVIDERS]).toEqual(['nodepod']);
  });

  it('reports webcontainer and codesandbox as disabled', () => {
    expect(isSandboxProviderEnabled('nodepod')).toBe(true);
    expect(isSandboxProviderEnabled('webcontainer')).toBe(false);
    expect(isSandboxProviderEnabled('codesandbox')).toBe(false);
  });

  /*
   * The property that matters, asserted over the DECLARED UNION rather than a list someone typed
   * here: whatever ids exist, every disabled one must resolve away. A test enumerating the two we
   * happen to have disabled today would not notice a fourth provider added and left reachable.
   */
  it('refuses every disabled id, whatever the config says', () => {
    for (const id of SANDBOX_PROVIDER_IDS) {
      if (isSandboxProviderEnabled(id)) {
        continue;
      }

      const warnings: string[] = [];
      expect(resolveSandboxProviderId(id, (m) => warnings.push(m))).toBe(DEFAULT_SANDBOX_PROVIDER);

      /*
       * A refusal must NAME the wall. A disabled provider that silently falls back reads exactly like
       * a variable being ignored, and the reader's next move is to set it somewhere "more official"
       * — a Docker arg, an SSM parameter — chasing a config bug that does not exist.
       */
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(id);
      expect(warnings[0]).toMatch(/disabled/i);
      expect(warnings[0]).toContain('ENABLED_SANDBOX_PROVIDERS');
    }
  });

  /* The refusal path must not become the crash path: this runs inside the server render. */
  it('still never throws for a disabled id', () => {
    for (const id of SANDBOX_PROVIDER_IDS) {
      expect(() => resolveSandboxProviderId(id)).not.toThrow();
    }
  });

  /* An enabled list that did not include the default would make every build unresolvable. */
  it('enables the default', () => {
    expect(isSandboxProviderEnabled(DEFAULT_SANDBOX_PROVIDER)).toBe(true);
  });

  /* Disabled means dormant, NOT deleted — hide-don't-delete. The traits must still be answered. */
  it('keeps a full trait record for disabled providers', () => {
    for (const id of SANDBOX_PROVIDER_IDS) {
      expect(SANDBOX_PROVIDER_TRAITS[id]).toBeDefined();
    }

    expect(ENABLED_SANDBOX_PROVIDERS.length).toBeLessThan(SANDBOX_PROVIDER_IDS.length);
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
