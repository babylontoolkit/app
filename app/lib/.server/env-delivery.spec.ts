/**
 * Every server env read the code can name must be DELIVERABLE in production.
 *
 * Under workerd `process.env` is empty; `bindings.sh` forwards only the names it finds in
 * `worker-configuration.d.ts`. A name read with `env(context, 'NAME')` (or `envNumber`/`envFlag`) but not
 * declared there is silently ignored in production — its code default applies, however carefully the
 * value was put into SSM. Found 2026-10-03 with 38 such names, including a billing rate
 * (`MANAGED_SESSION_HOUR_USD`) and the Max-effort switch. Default-deny: a new read fails here until it is
 * declared, or listed below WITH a reason.
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const NOT_DELIVERED_BY_DESIGN: Record<string, string> = {
  UPSTREAM_LLM_ROUTES_ENABLED:
    'Upstream /api/chat + /api/llmcall are unmetered and unauthenticated when on — they must be impossible to enable in production.',
  VITE_GITHUB_ACCESS_TOKEN:
    'A VITE_ variable is inlined into the client bundle at build time, never a runtime binding.',
};

/*
 * Direct reads (`env(ctx, 'X')`, `envNumber`, `envFlag`, `envBool`), the wrappers that take a key
 * (`numberSetting(ctx, 'X', …)`, `readEnv('X', …)`), provider `baseUrlKey`/`defaultBaseUrlKey: 'X'`, and
 * `*_ENV_KEY = 'X'` constants. A key built at runtime cannot be scanned — those are listed in COMPUTED.
 */
const READS = [
  /\benv(?:Number|Flag|Bool)?\(\s*[\w.]+\s*,\s*'([A-Za-z][A-Za-z0-9_]+)'/g,
  /\bnumberSetting\(\s*[\w.]+\s*,\s*'([A-Z][A-Z0-9_]+)'/g,
  /\breadEnv\(\s*'([A-Z][A-Z0-9_]+)'/g,
  /\b(?:default)?[bB]aseUrlKey:\s*'([A-Z][A-Z0-9_]+)'/g,
  /\b[A-Z][A-Z0-9_]*_ENV_KEY\s*=\s*'([A-Z][A-Z0-9_]+)'/g,
];

/** Names built at runtime (`${provider.toUpperCase()}_ENHANCE_PROMPT_MODEL`, env-models.ts) — one per text gateway. */
const COMPUTED = [
  'KIE_ENHANCE_PROMPT_MODEL',
  'ANTHROPIC_ENHANCE_PROMPT_MODEL',

  /* `${prefix}_OAUTH_CLIENT_ID` / `_SECRET`, prefix GITHUB | GITLAB (git/oauth.ts). */
  'GITHUB_OAUTH_CLIENT_ID',
  'GITHUB_OAUTH_CLIENT_SECRET',
  'GITLAB_OAUTH_CLIENT_ID',
  'GITLAB_OAUTH_CLIENT_SECRET',
];

/** Any env read whose key is a template literal must have its expansions listed in COMPUTED. */
const TEMPLATE_READ = /\benv(?:Number|Flag|Bool)?\(\s*[\w.]+\s*,\s*`([^`]*\$\{[^`]*)`/g;

/** The exact extraction `bindings.sh` performs — `grep -oE '^[[:space:]]*[A-Za-z_][A-Za-z0-9_]*:'` per line. */
const BINDINGS_PATTERN = "grep -oE '^[[:space:]]*[A-Za-z_][A-Za-z0-9_]*:' worker-configuration.d.ts";

function namesBindingsForwards(): Set<string> {
  return new Set(
    readFileSync('worker-configuration.d.ts', 'utf8')
      .split('\n')
      .map((line) => /^\s*([A-Za-z_][A-Za-z0-9_]*):/.exec(line)?.[1])
      .filter((name): name is string => Boolean(name)),
  );
}

/** What production receives: exactly the names `bindings.sh` extracts — a name only in a doc comment does not count. */
function declared(): Set<string> {
  return namesBindingsForwards();
}

function readsInApp(): Map<string, string> {
  const files = execSync('git ls-files app', { encoding: 'utf8' })
    .split('\n')
    .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.spec\.|\.testkit\./.test(f));
  const reads = new Map<string, string>();

  for (const file of files) {
    const source = readFileSync(file, 'utf8');

    for (const pattern of READS) {
      for (const m of source.matchAll(pattern)) {
        if (!reads.has(m[1])) {
          reads.set(m[1], file);
        }
      }
    }
  }

  for (const name of COMPUTED) {
    reads.set(name, 'app/lib/modules/llm/providers/env-models.ts (computed)');
  }

  return reads;
}

describe('every server env read reaches production (worker-configuration.d.ts)', () => {
  it('bindings.sh extracts names with digits and lowercase (S3_BUCKET was dropped as `_BUCKET` until 2026-10-03)', () => {
    expect(readFileSync('bindings.sh', 'utf8')).toContain(BINDINGS_PATTERN);

    const forwarded = namesBindingsForwards();

    for (const name of ['S3_BUCKET', 'S3_SECRET_ACCESS_KEY', 'HuggingFace_API_KEY', 'AGENT_TURN_MAX_CREDITS']) {
      expect(forwarded.has(name), `${name} must be forwarded`).toBe(true);
    }

    expect(forwarded.has('_BUCKET')).toBe(false);
  });

  it('declares every name the app reads, except the documented exclusions', () => {
    const names = declared();
    const missing = [...readsInApp()]
      .filter(([name]) => !names.has(name) && !(name in NOT_DELIVERED_BY_DESIGN))
      .map(([name, file]) => `${name} (read in ${file})`);

    expect(missing).toEqual([]);
  });

  it('every template-literal env key is accounted for in COMPUTED', () => {
    const files = execSync('git ls-files app', { encoding: 'utf8' })
      .split('\n')
      .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.spec\.|\.testkit\./.test(f));
    const unlisted: string[] = [];

    for (const file of files) {
      for (const m of readFileSync(file, 'utf8').matchAll(TEMPLATE_READ)) {
        const suffix = m[1].replace(/^.*\}/, '');

        if (!COMPUTED.some((name) => name.endsWith(suffix))) {
          unlisted.push(`${m[1]} (read in ${file})`);
        }
      }
    }

    expect(unlisted).toEqual([]);
  });

  it('CONTROL: the scanner finds reads, and the exclusions are really read (no stale entries)', () => {
    const reads = readsInApp();

    expect(reads.has('ANTHROPIC_API_KEY') || reads.has('BILLING_ENFORCED')).toBe(true);
    expect(reads.has('AGENT_TURN_MAX_CREDITS'), 'numberSetting wrapper scanned').toBe(true);
    expect(reads.has('LLM_PROVIDER_CHAIN'), '*_ENV_KEY constant scanned').toBe(true);
    expect(reads.has('KIE_BASE_URL'), 'baseUrlKey scanned').toBe(true);
    expect(reads.size).toBeGreaterThan(40);

    for (const name of Object.keys(NOT_DELIVERED_BY_DESIGN)) {
      expect(reads.has(name), `${name} is no longer read — drop it from the exclusions`).toBe(true);
      expect(declared().has(name), `${name} is excluded by design and must NOT be declared`).toBe(false);
    }
  });

  it('CONTROL: the declaration parser sees both the upstream and the platform block', () => {
    const names = declared();

    expect(names.has('ANTHROPIC_API_KEY')).toBe(true);
    expect(names.has('SUPABASE_SERVICE_ROLE_KEY')).toBe(true);
    expect(names.has('ENABLE_MAX_EFFORT')).toBe(true);
  });
});
