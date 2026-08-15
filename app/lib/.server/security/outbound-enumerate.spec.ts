/**
 * EVERY api route is walled unless it is explicitly, reasonedly public (SPEC §5, `spec/spend-holes.md`).
 *
 * `outbound-auth.spec.ts` is the behavioural wall: it drives each handler unauthenticated and asserts
 * 401 with zero outbound `fetch`. But it can only assert about routes someone remembered to import, and
 * on 2026-07-19 the sweep that wrote it went looking for routes named after VENDORS — `github-*`,
 * `gitlab-*`, `netlify-*`, `vercel-*`, `supabase*`, `git-proxy`. Every one of those got a guard.
 *
 * Routes named after SUBSYSTEMS did not: `api.system.git-info` (which served an anonymous caller the
 * PLATFORM GitHub token's private repos, with PRECEDENCE over the caller's own), `api.system.diagnostics`,
 * `api.github-template`, `api.models`, `api.bug-report`. The hand-written list then encoded that blind
 * spot AS COVERAGE — 21 green assertions reporting a clean bill of health about a set that never
 * contained the holes. Same shape as `wastedOutput` and `tool_rounds`: **a check defined in terms of the
 * failure it expects reports success on the failure it does not.**
 *
 * ⚠️ The first version of this file tried to be clever — scan for `fetch(` and require a guard on
 * whatever matched. It found three of the five and MISSED `api.github-template` and `api.models`, because
 * they reach out through helpers (`fetchTemplateFiles`, `LLMManager`) and contain no literal `fetch(`.
 * A detector that decides which routes matter reproduces the original bug with a regex instead of a
 * person. So this is DEFAULT-DENY: every `api.*` route needs a wall, and the exceptions are enumerated
 * below with reasons. Being open is the thing you have to justify.
 *
 * This is a SOURCE scan: it proves a wall is *mentioned*, never that it is reached — a guard whose
 * result is ignored passes here. `outbound-auth.spec.ts` proves the wall actually holds. Complements,
 * neither replacing the other.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROUTES_DIR = join(process.cwd(), 'app/routes');

/** Comments are not code: a guard named in a doc comment must not count as a wall. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/**
 * Anything that refuses a caller who has no business here. Which wall is right is per-route — a session,
 * an ownership check, an admin check, or the fail-closed switches that 404 the dead upstream LLM/MCP
 * routes outright. That NO wall is present is always wrong.
 */
const WALL =
  /denyUnlessVerified|requireVerifiedUser|requireUser|requireAdmin|requireOwnedProject|upstreamLlmRouteDisabled|serverSideMcpDisabled|requireUnitySubscriptionKey/;

/** A Remix route only does anything if it actually exports a handler. */
const HANDLER = /export\s+(?:async\s+function|const|function)\s+(?:loader|action)\b/;

/**
 * Routes that are DELIBERATELY reachable without a session. Each reason has to survive being read back
 * in a year — "it seemed harmless" is how the five above shipped. Adding an entry is a decision; make it
 * in review, in writing.
 */
const PUBLIC_BY_DESIGN: Record<string, string> = {
  'api.auth.ts': 'Sign-in/sign-up itself. A wall here would make an account unobtainable.',
  'api.git.callback.$provider.ts': 'OAuth redirect target — the provider calls it, not a session. State-validated.',
  'api.me.ts': 'Reports whether the caller is signed in; must answer "no" rather than refuse.',
  'api.health.ts': 'Liveness/readiness for the deploy checks (§5A). Reports config state as booleans, never values.',
  'api.stripe-webhook.ts': 'Stripe calls it. Authenticated by signature verification, which a session cannot replace.',
  'api.monitoring.client-error.ts':
    'Client error capture (§5A) — errors from signed-out pages are the ones worth having.',
  'api.play.$shareId.report.ts': 'Anonymous abuse reporting on a public /play build is the point (§4.8).',
  'api.gallery.ts': 'The public gallery. Admin-approved rows only; no per-user data.',
  'api.check-env-key.ts': 'Answers "is a key configured?" as a BOOLEAN and never the value (§5).',
  'api.configured-providers.ts': 'Provider names + configured booleans. No keys, no outbound calls.',
  'api.registry.ts': 'Static game registry (§4.4) — genre copy and keywords, shown before signup.',
  'api.skills.ts': 'Skill NAMES and descriptions for the / autocomplete. Bodies are never served (§4.11).',
  'api.assets.catalog.ts': 'Static catalog config (§4.9). Premium items are gated at ADD, not at read.',
  'api.chat.ts': 'Dead upstream route; `upstreamLlmRouteDisabled` 404s it. Fail-closed, not merely walled.',
  'api.llmcall.ts': 'Dead upstream route; `upstreamLlmRouteDisabled` 404s it. Fail-closed, not merely walled.',
  'api.mcp-check.ts': 'Server-side MCP is fail-closed (§4.14 RCE); the guard 404s it unless explicitly enabled.',
  'api.mcp-update-config.ts':
    'Server-side MCP is fail-closed (§4.14 RCE); the guard 404s it unless explicitly enabled.',
  'api.update.ts':
    'Upstream self-update; refuses to auto-pull, and the Features toggle that drove it is hidden (§2.3).',

  /*
   * ⚠️ NOT a blessing — these two run `execSync` on the host and return branch/commit/disk facts to an
   * anonymous caller. Disclosure only (fixed commands, no caller input reaches the shell), so they are
   * not in the same class as the five fixed on 2026-07-20, but they are unresolved, not approved.
   */
  'api.git-info.ts': 'FLAGGED, undecided: anonymous host `git` disclosure via execSync. Fixed commands only.',
  'api.system.disk-info.ts': 'FLAGGED, undecided: anonymous host `df` disclosure via execSync. Fixed commands only.',
};

interface RouteSource {
  file: string;
  source: string;
}

function apiRoutes(): RouteSource[] {
  return readdirSync(ROUTES_DIR)
    .filter((f) => /^api\..*\.tsx?$/.test(f) && !f.includes('.spec.'))
    .map((file) => ({ file, source: stripComments(readFileSync(join(ROUTES_DIR, file), 'utf8')) }))
    .filter(({ source }) => HANDLER.test(source));
}

const routes = apiRoutes();

describe('every api route is walled or explicitly public (enumerated from disk, never a hand-written list)', () => {
  /*
   * The control. A scan that silently stops matching anything reports "all clear" forever — which is
   * precisely how a structural test decays into decoration. If this fails, the scanner is broken and
   * every assertion below is meaningless, whatever colour it prints.
   */
  it('the scanner still finds routes at all', () => {
    expect(routes.length).toBeGreaterThan(30);
    expect(routes.filter((r) => WALL.test(r.source)).length).toBeGreaterThan(15);
  });

  it('the scanner does not count a wall named only in a comment', () => {
    expect(WALL.test(stripComments('/* uses denyUnlessVerified */\nexport async function loader() {}'))).toBe(false);
  });

  it('the five subsystem-named routes the vendor-name sweep missed are now walled', () => {
    /*
     * Named explicitly, not because the loop below misses them, but because their ABSENCE from a sweep
     * is the actual defect being pinned. A rename that drops one out of the enumeration fails here
     * loudly rather than quietly leaving coverage.
     */
    const walled = routes.filter((r) => WALL.test(r.source)).map((r) => r.file);

    expect(walled).toEqual(
      expect.arrayContaining([
        'api.system.git-info.ts',
        'api.system.diagnostics.ts',
        'api.github-template.ts',
        'api.models.ts',
        'api.bug-report.ts',
      ]),
    );
  });

  it('the public-by-design list has no stale entries', () => {
    /* An entry for a route that no longer exists is a licence nobody is watching. */
    const onDisk = new Set(routes.map((r) => r.file));

    for (const file of Object.keys(PUBLIC_BY_DESIGN)) {
      expect(onDisk.has(file), `${file} is allow-listed but no longer exists`).toBe(true);
    }
  });

  for (const { file, source } of routes) {
    const reason = PUBLIC_BY_DESIGN[file];

    it(`${file} → ${reason ? 'public by design, with a reason' : 'refuses an unauthorised caller'}`, () => {
      if (reason) {
        // A one-word reason is not a reason.
        expect(reason.length, `${file} needs a real justification for being public`).toBeGreaterThan(30);
        return;
      }

      expect(WALL.test(source), `${file} has no auth wall and is not in PUBLIC_BY_DESIGN`).toBe(true);
    });
  }
});

/**
 * The platform's own credentials are never a fallback for a caller who supplied none.
 *
 * `api.github-user`'s `get_token` and `api.system.git-info` did exactly that, a year apart, in the same
 * repo — the second worse (precedence, not fallback). A route may ACT on a platform secret; it may never
 * hand one to the caller, and it may never let an authenticated-but-tokenless user borrow it to read the
 * operator's own account.
 */
describe('the platform GitHub token is not a fallback for the caller', () => {
  it('api.system.git-info reads only the caller-supplied token', () => {
    const source = stripComments(readFileSync(join(ROUTES_DIR, 'api.system.git-info.ts'), 'utf8'));

    expect(source).not.toMatch(/GITHUB_ACCESS_TOKEN|GITHUB_TOKEN/);
    expect(source).toMatch(/headerToken\s*\|\|\s*cookieToken/);
  });
});
