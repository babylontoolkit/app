/**
 * THE MODEL TIER LADDER, WHERE IT MEETS THE PROXY (§4.6.1a, T6).
 *
 * T6 replaced the two-model premium branch in `proxy.ts` — `getPremiumTier` → `decidePremium` →
 * `getPremiumModel` — with a ladder block, and generalized `getPremiumModel` into
 * `getTierModel(id, context)`. Two things needed pinning, and they fail in different ways:
 *
 *   1. **`getTierModel` is a real seam** — a config function with rules in it — so it is driven
 *      BEHAVIOURALLY here. The rule that broke twice already is the ERROR TEXT: it used to name
 *      `PREMIUM_MODEL` unconditionally (and before that, retired `*_DOLLARS` vars), which with three
 *      rungs sends an operator to fix a setting that was never broken. Nothing tests the text of a
 *      failure path unless someone writes it down, which is how the retired-var instruction survived.
 *
 *   2. **The proxy WIRING has no seam at all.** Nothing drives `runAgentGeneration` end to end (the
 *      proxy specs stop at the prompt, the billing specs start at `settleGeneration`), so the ladder
 *      block is read from the source in the `first-build-turn.spec.ts` / `creation-flat.spec.ts`
 *      shape: comment-stripped, scoped to a single declaration or a single call's arguments by brace
 *      matching, and guarded by CONTROLS. A scan that silently matches nothing reports all-clear
 *      forever, so every extractor is proven to have found real code before anything is asserted.
 *
 *   3. **The ROUTE half (T7) — and this one IS driven.** `api.agent.ts`'s `action` is exported and
 *      the only two things it needs from the world are a verified user and `runAgentGeneration`, so
 *      section 3 mocks exactly those two, POSTs a real `Request`, and reads the bytes off the
 *      response stream. That matters for the property the whole ladder is observed through: the
 *      `agentMeta` annotation must name the rung that RAN, never the one that was asked for — and a
 *      source scan can only see that `generation.` is spelled somewhere near it, where a live drive
 *      can hand the route a request for SuperMax, a generation that ran Standard, and check which one
 *      comes out on the wire. Only the two things a request cannot express — the boundary TYPE of
 *      `tier` and the surviving legacy alias in the body shape — stay a scan.
 *
 * ⚠️ A spec file must NEVER live in `app/routes/` (Remix compiles it as a route, the manifest imports
 * `vitest` at runtime, and every request 500s). Route tests live beside the code they exercise, which
 * is why the route half is here rather than next to `api.agent.ts`.
 *
 * ## What is deliberately NOT here
 *
 * `decideModelTier`'s own rules — the exhaustive requested × balance × turn cross-product, the
 * "declines to STANDARD, never down one rung", the unrecognised-id-resolves-DOWN table, the
 * first-build lock — are already pinned in `billing/premium.spec.ts`, and the ladder TABLE and
 * `getModelTier` (the rates-layer half) in `billing/model-tiers.spec.ts`. Restating them here would be
 * a second copy to drift. What neither of those can see is whether the proxy still HANDS the decision
 * its inputs, which is this file's half.
 *
 * ⚠️ `env()` falls back to `process.env` and Vitest loads `.env.local` — which on a real developer's
 * machine sets `LLM_MODEL`, `LLM_PROVIDER`, `PREMIUM_MODEL` and `PREMIUM_MINIMUM_CREDITS` — plus, on
 * an upgrading machine, the RETIRED `ENABLE_EXTENDED_MODELS` / `SUPERMAX_*`, which now make
 * `getTierModel` throw outright. Every case that means to test a DEFAULT scrubs the
 * WHOLE precedence chain, not just the variable under test (the `oauth.spec.ts` trap, which fired a
 * second time in `billing.spec.ts` for want of one sibling in a scrub list).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NotConfiguredError, getPremiumModel, getTierModel } from './config';
import { invalidateMarketPricesCache } from '~/lib/.server/billing/market-price-store';
import { DEFAULT_PREMIUM_MODEL } from '~/lib/.server/billing/model-tiers';
import type { AgentGeneration } from './proxy';
import { action as agentRouteAction } from '~/routes/api.agent';

/*
 * The route's two doors to the world, and nothing else (section 3).
 *
 * `vi.mock` is hoisted above the imports, so `vi.hoisted` is how the spies exist before the factories
 * run. The auth mock SPREADS the original rather than replacing the module: `requireVerifiedUser` is
 * the only export the route needs, but a plain factory silently deletes `UnauthorizedError` and
 * friends for anything else that reaches this module graph later — a failure that would land on an
 * unrelated test. `runAgentGeneration` is replaced outright: the real proxy is precisely what section
 * 2 reads from disk, and loading it here would drag the whole prompt builder into a route test.
 */
const routeMocks = vi.hoisted(() => ({
  runAgentGeneration: vi.fn(),
  requireVerifiedUser: vi.fn(),
}));

vi.mock('~/lib/.server/agent/proxy', () => ({
  runAgentGeneration: routeMocks.runAgentGeneration,
}));

vi.mock('~/lib/.server/supabase/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  requireVerifiedUser: routeMocks.requireVerifiedUser,
}));

/**
 * Every env var that can reach a tier resolution — selectors, thresholds, the provider, the platform
 * model, and the RETIRED price vars (which throw before any of the above is even read).
 */
const TIER_ENV = [
  'LLM_MODEL',
  'LLM_PROVIDER',
  'KIE_DEFAULT_MODEL',

  /*
   * `AUTO_MODEL_SELECT` joined the "which gateway" precedence chain on 2026-08-10, and the owner's
   * `.env.local` really does set it (with a chain, and all three keys). `getTierModel` reads the plain
   * `getPlatformProvider` today, so none of these can reach it — but that is a fact about the current
   * implementation, not about this scrub list, and the same omission has already silently rewritten
   * three cases in `platform-key.spec.ts`. Scrubbing the whole chain costs nothing and means a future
   * routing change fails here loudly instead of on one developer's machine.
   */
  'AUTO_MODEL_SELECT',
  'LLM_PROVIDER_CHAIN',
  'ANTHROPIC_API_KEY',
  'KIE_API_KEY',
  'COMET_API_KEY',
  'PREMIUM_MODEL',
  'PREMIUM_MINIMUM_CREDITS',
  'ENABLE_EXTENDED_MODELS',

  /* The per-rung switches: a leftover `false` withdraws the rung and fails every case below it. */
  'ENABLE_PREMIUM_MODEL',
  'ENABLE_PLATINUM_MODEL',
  'PLATINUM_MODEL',
  'PLATINUM_MINIMUM_CREDITS',

  // Retired, and now REFUSED if set — a leftover on an upgrading machine fails every case here.
  'ENABLE_EXTENDED_MODELS',
  'SUPERMAX_MODEL',
  'SUPERMAX_MINIMUM_CREDITS',
  'KIE_INPUT_DOLLARS',
  'KIE_OUTPUT_DOLLARS',
  'KIE_CACHED_INPUT',
  'KIE_CACHED_WRITES',
  'PREMIUM_INPUT_DOLLARS',
  'PREMIUM_OUTPUT_DOLLARS',
] as const;

/** Scrub the whole chain, then apply only what this case means to say. */
function stubTierEnv(vars: Partial<Record<string, string>> = {}) {
  for (const key of TIER_ENV) {
    vi.stubEnv(key, (vars[key] ?? undefined) as unknown as string);
  }

  for (const [key, value] of Object.entries(vars)) {
    if (!(TIER_ENV as readonly string[]).includes(key)) {
      vi.stubEnv(key, value as string);
    }
  }
}

beforeEach(() => {
  invalidateMarketPricesCache();
});

afterEach(() => {
  vi.unstubAllEnvs();
  invalidateMarketPricesCache();
});

const REPO = process.cwd();

/** Read for the ONE assertion below that is about a type rather than a value — see its comment. */
const configSource = readFileSync(join(REPO, 'app/lib/.server/agent/config.ts'), 'utf-8');

/* ============================================================ 1. getTierModel — the real seam */

describe('getTierModel — every rung resolves its OWN model, from code, with no environment', () => {
  it('resolves Premium to Fable 5', () => {
    stubTierEnv();

    expect(getTierModel('premium', {})).toBe(DEFAULT_PREMIUM_MODEL);
    expect(getTierModel('premium', {})).toBe('claude-fable-5');
  });

  /*
   * On BOTH providers. A rung's row is injected into every provider's table (`providerRates`), so this
   * is normally satisfied by construction — it is asserted because the thing it would catch is a rung
   * that resolves on the provider a developer happens to run and refuses on the one production uses.
   */
  it.each(['KIE', 'Anthropic'])('resolves the paid rung on %s', (provider) => {
    stubTierEnv({ LLM_PROVIDER: provider });

    expect(getTierModel('premium', {})).toBe('claude-fable-5');
  });

  /* The env var is a SELECTOR: it names a model, and the ACTIVE price list prices it. */
  it('honours the rung’s own selector, and trims it', () => {
    stubTierEnv({ PREMIUM_MODEL: '  claude-fable-5  ' });

    expect(getTierModel('premium', {})).toBe('claude-fable-5');
  });

  /*
   * 🔴 THE RUNGS ARE INDEPENDENT — asserted STRUCTURALLY, because with one paid rung it can no longer
   * be asserted behaviourally (2026-08-08).
   *
   * The behavioural version read "resolve SuperMax while PREMIUM_MODEL names a model nothing can
   * price", and it was the test that would have caught a shared resolve-the-ladder step throwing for
   * every rung at once. It died with the rung, and the honest thing is to say so rather than quietly
   * drop a property: what survives is the mechanism that made it true — the selector and the error
   * text are read from THIS rung's definition, never from a literal.
   *
   * A hardcoded `'PREMIUM_MODEL'` here is correct today and wrong the moment a second rung returns,
   * which is exactly the class of regression a source scan can still see and a one-rung behavioural
   * test cannot.
   */
  it('reads the selector from the rung’s own definition, never from a literal', () => {
    const body = configSource.slice(configSource.indexOf('export function getTierModel('));

    expect(body).toContain('paidModelTierDefinition(id)');
    expect(body.slice(0, body.indexOf('export function getPremiumModel'))).not.toMatch(/'PREMIUM_MODEL'/);
  });

  /* CONTROL for the scan above — it is reading a real function body, not an empty string. */
  it('control — the scanned body is really getTierModel', () => {
    expect(configSource).toContain('export function getTierModel(');
    expect(configSource.indexOf('export function getPremiumModel')).toBeGreaterThan(
      configSource.indexOf('export function getTierModel('),
    );
  });

  /*
   * `standard` has no selector, no threshold and no lock, so it is excluded BY TYPE rather than by a
   * runtime check — `PaidModelTierId` is `ModelTierId` minus the free rung. Asserted on the SIGNATURE
   * (eslint bans `@ts-expect-error`, and a runtime call would have to defeat the type to be written at
   * all) so widening the parameter to `ModelTierId` — which would silently give the free rung a paid
   * door with a selector and a threshold it does not have — fails here.
   */
  it('cannot be handed the free rung — `standard` is excluded by type', () => {
    expect(configSource).toMatch(/export function getTierModel\(id: PaidModelTierId/);
  });
});

describe('getTierModel — an unpriceable selector is refused, naming the rung’s OWN variable', () => {
  /*
   * ⚠️ The message text IS the behaviour here. It used to instruct the operator to set
   * `PREMIUM_INPUT_DOLLARS` / `PREMIUM_OUTPUT_DOLLARS` — variables the platform has REFUSED at config
   * time since 2026-07-18 — and it survived because nothing tests the text of a failure path.
   */

  /*
   * THE CONTROL, and it is what makes the assertion above mean something: the same failure one rung
   * down names the OTHER variable. Without this pair, hardcoding either name passes one test and fails
   * the other only by accident of which rung the case happened to pick.
   */
  it('CONTROL — the same failure on Premium names PREMIUM_MODEL, never SUPERMAX_MODEL', () => {
    stubTierEnv({ PREMIUM_MODEL: 'not-a-real-model' });

    let thrown: unknown;

    try {
      getTierModel('premium', {});
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(NotConfiguredError);

    const message = String((thrown as Error).message);

    expect(message).toContain('PREMIUM_MODEL');
    expect(message).toContain('not-a-real-model');
    expect(message).not.toContain('SUPERMAX_MODEL');
    expect(message).not.toContain('_DOLLARS');
  });

  /* And it points at the one place prices actually live, so the instruction is followable. */
  it('directs the operator to the Marketplace price list', () => {
    stubTierEnv({ PREMIUM_MODEL: 'not-a-real-model' });
    expect(() => getTierModel('premium', {})).toThrow(/Marketplace price list/);
  });
});

/**
 * 🔴 `getTierModel(id, context, providerOverride)` — AND AN HONEST ACCOUNT OF WHAT IT BUYS.
 *
 * The third argument arrived with `AUTO_MODEL_SELECT`: the gateway is chosen PER REQUEST, so a caller
 * holding `config.provider` must be able to say so rather than let this re-derive from `LLM_PROVIDER`
 * — two readers of one decision, on the most expensive rung in the product (`kieEnvModel`, exactly).
 *
 * ⚠️ **It is NOT observable through this function's return value or its error, for any real
 * configuration, and the implementation's own comment says so.** `providerRates` gap-fills every
 * resolvable rung's model into EVERY provider's table (`rates.ts` `withTiers`, fill-never-overwrite),
 * so for an enabled rung the price lookup below succeeds on every gateway by construction; and a rung
 * that is disabled, or whose selector the Marketplace list cannot price, throws BEFORE the provider is
 * ever consulted. There is no input that makes the argument change the answer.
 *
 * So this block does the only two honest things available:
 *
 *   1. It PINS THE UNOBSERVABILITY as a property. If someone makes the check bite — a per-provider
 *      ladder, a gate on native pricing — these cases fail and demand a real behavioural pin instead
 *      of leaving one to be written from memory.
 *   2. It reads the resolution from the source, because that is the only instrument that can see the
 *      argument being used at all. The behavioural half of the parameter — the price table it selects
 *      — is driven with a stubbed rates seam in `tier-model-provider.spec.ts`, and the proxy call site
 *      is pinned in `provider-select-wiring.spec.ts`.
 */
describe('getTierModel — the provider override, and what it can and cannot be observed to do', () => {
  it.each(['Anthropic', 'KIE', 'Comet'] as const)('accepts an explicit %s and resolves the rung', (provider) => {
    stubTierEnv();

    expect(getTierModel('premium', {}, provider)).toBe('claude-fable-5');
  });

  /*
   * THE PROPERTY, stated directly: an enabled rung resolves identically on every gateway, INCLUDING a
   * gateway that does not price the model natively. That is `withTiers`' gap-fill, and it is why the
   * argument cannot be caught by a behavioural test here. `claude-fable-5` is the live example — the
   * owner's deploy runs it, and Anthropic bakes no row for it.
   */
  it('resolves the same model on every gateway, even one with no native row for it', () => {
    stubTierEnv({ PREMIUM_MODEL: 'claude-fable-5' });

    const answers = (['Anthropic', 'KIE', 'Comet'] as const).map((provider) => getTierModel('premium', {}, provider));

    expect(answers).toEqual(['claude-fable-5', 'claude-fable-5', 'claude-fable-5']);
  });

  /*
   * ⚠️ If this ever fails, the override has become observable and the comment above is out of date.
   * Write the real behavioural pin then — do not relax this into `toBeDefined()`.
   */
  it('the override cannot change the answer while the rung is gap-filled into every table', () => {
    stubTierEnv({ LLM_PROVIDER: 'Anthropic', PREMIUM_MODEL: 'claude-fable-5' });

    expect(getTierModel('premium', {})).toBe(getTierModel('premium', {}, 'Comet'));
    expect(getTierModel('premium', {})).toBe(getTierModel('premium', {}, 'KIE'));
  });

  /* Omitting the argument must behave exactly as it did before the parameter existed. */
  it('falls back to LLM_PROVIDER when no override is given', () => {
    stubTierEnv({ LLM_PROVIDER: 'KIE' });

    expect(getTierModel('premium', {})).toBe(getTierModel('premium', {}, 'KIE'));
  });

  /*
   * The walls run BEFORE the provider is consulted, which is the other half of why no override can be
   * observed: a withdrawn rung refuses whoever asks, and the refusal names the FLAG rather than a
   * price list, because that is the one thing the operator has to change.
   */
  it('a withdrawn rung refuses on every gateway, naming the flag and not the provider', () => {
    stubTierEnv({ ENABLE_PREMIUM_MODEL: 'false' });

    for (const provider of ['Anthropic', 'KIE', 'Comet'] as const) {
      expect(() => getTierModel('premium', {}, provider)).toThrow(NotConfiguredError);
      expect(() => getTierModel('premium', {}, provider)).toThrow(/ENABLE_PREMIUM_MODEL/);
    }
  });

  /*
   * SOURCE. `providerOverride ?? getPlatformProvider(context)` is a five-character deletion that no
   * assertion above can see, and it silently returns the money path to validating the rung against
   * `LLM_PROVIDER` while a different gateway serves and bills it.
   */
  it('resolves the provider from the override, falling back to getPlatformProvider', () => {
    const body = configSource.slice(
      configSource.indexOf('export function getTierModel('),
      configSource.indexOf('export function getPremiumModel'),
    );

    expect(body).toMatch(/const provider = providerOverride \?\? getPlatformProvider\(context\)/);
    expect(body, 'the price table must be indexed by that resolution, not re-derived').toMatch(
      /providerRates\(context\)\[provider\]/,
    );
  });

  it('declares the override as an optional third parameter, typed as a platform provider', () => {
    expect(configSource).toMatch(
      /export function getTierModel\(\s*id: PaidModelTierId,\s*context\?: unknown,\s*providerOverride\?: PlatformProviderName,?\s*\)/,
    );
  });

  /* CONTROL — the slice above is a real function body and really ends where this thinks it does. */
  it('CONTROL — the scanned body is getTierModel and contains its price check', () => {
    const body = configSource.slice(
      configSource.indexOf('export function getTierModel('),
      configSource.indexOf('export function getPremiumModel'),
    );

    expect(body.length).toBeGreaterThan(500);
    expect(body).toContain('paidModelTierDefinition(id)');
    expect(body).toContain('if (!priced[model])');
    expect(body).not.toContain('export function getPremiumModel');
  });
});

describe('getPremiumModel — a deprecated wrapper, not a second implementation', () => {
  /*
   * The wrapper exists so the pre-ladder callers keep compiling. It must DELEGATE: a second copy of
   * the resolution is a second copy of the price validation, and a drifted copy of a money rule fails
   * silently. Asserted across a default, a selector, and a failure — the three ways it could diverge.
   */
  it('agrees with getTierModel("premium") on the default', () => {
    stubTierEnv();
    expect(getPremiumModel({})).toBe(getTierModel('premium', {}));
    expect(getPremiumModel({})).toBe('claude-fable-5');
  });

  it('agrees with getTierModel("premium") on a configured selector', () => {
    stubTierEnv({ PREMIUM_MODEL: 'claude-fable-5' });
    expect(getPremiumModel({})).toBe(getTierModel('premium', {}));
    expect(getPremiumModel({})).toBe('claude-fable-5');
  });

  it('throws the identical error for an unpriceable selector', () => {
    stubTierEnv({ PREMIUM_MODEL: 'not-a-real-model' });

    const wrapper = (() => {
      try {
        getPremiumModel({});

        return null;
      } catch (error) {
        return error as Error;
      }
    })();

    const direct = (() => {
      try {
        getTierModel('premium', {});

        return null;
      } catch (error) {
        return error as Error;
      }
    })();

    expect(wrapper).toBeInstanceOf(NotConfiguredError);
    expect(direct).toBeInstanceOf(NotConfiguredError);
    expect(wrapper?.message).toBe(direct?.message);
  });

  /* It must not have quietly become "whatever rung is cheapest/most expensive" — it is PREMIUM. */
  it('resolves the premium rung specifically, not the platform model', () => {
    stubTierEnv({ PREMIUM_MODEL: 'claude-opus-5', LLM_MODEL: 'claude-sonnet-5' });

    expect(getPremiumModel({})).toBe('claude-opus-5');
    expect(getPremiumModel({})).toBe(getTierModel('premium', {}));
  });
});

/* ================================================= 2. the proxy ladder block — a scan with controls */

const proxyRaw = readFileSync(join(REPO, 'app/lib/.server/agent/proxy.ts'), 'utf-8');

/**
 * Comments are documentation, not behaviour, and here that is load-bearing: the ladder block's own
 * prose says "`tier` wins over the legacy `premium` boolean" and "BYOK short-circuits to standard", so
 * an unstripped scan would find every wiring below satisfied by the comment that DESCRIBES it — the
 * exact false all-clear this file exists to prevent (`shell-strip.ts`: a comment cannot fail).
 */
const proxy = proxyRaw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** The arguments of one call, brace-matched from `name({` to its closing `}` (creation-flat.spec.ts). */
function callArgs(source: string, name: string): string {
  const start = source.indexOf(`${name}({`);

  if (start < 0) {
    return '';
  }

  const open = source.indexOf('{', start);
  let depth = 0;

  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') {
      depth++;
    } else if (source[i] === '}' && --depth === 0) {
      return source.slice(open, i + 1);
    }
  }

  return '';
}

/**
 * One declaration, from `const <name> =` to its terminating `;`.
 *
 * `first-build-turn.spec.ts`'s `statement()` stops at the end of the LINE, which is right for the
 * wirings it reads and silently wrong here: `const model = …` and `const tierNotice = …` are both
 * formatted across several lines, so a line-scoped extractor would return `const model =` and every
 * `toContain` below would fail for a reason that has nothing to do with the code.
 */
function declaration(source: string, name: string): string {
  const start = source.indexOf(`const ${name} =`);

  if (start < 0) {
    return '';
  }

  const end = source.indexOf(';', start);

  return source.slice(start, end < 0 ? source.length : end + 1);
}

describe('CONTROLS — the ladder scan can still see the code it judges', () => {
  it('reads a real, non-trivial proxy.ts', () => {
    expect(proxy.length).toBeGreaterThan(10_000);
    expect(proxy).toContain('export async function runAgentGeneration');
  });

  it('strips comments, so the prose describing the ladder is not the ladder', () => {
    expect(proxyRaw).toContain('wins over the legacy');
    expect(proxy).not.toContain('wins over the legacy');

    // The deprecation note names the alias in prose; only the CODE may satisfy the alias assertion.
    expect(proxyRaw).toContain('still accepted as an alias');
    expect(proxy).not.toContain('still accepted as an alias');
  });

  it('extracts real, non-empty expressions for every declaration asserted below', () => {
    // Each is proven against a token it carries for reasons unrelated to the property under test.
    expect(declaration(proxy, 'byokModel')).toContain('request.model');
    expect(declaration(proxy, 'standardModel')).toContain('getPlatformModel');
    expect(declaration(proxy, 'requestedTier')).toContain('request.tier');
    expect(declaration(proxy, 'model')).toContain('tierDecision');
    expect(declaration(proxy, 'tierNotice')).toContain('below_minimum');
    expect(callArgs(proxy, 'decideModelTier')).toContain('requested');
  });
});

describe('the ladder is resolved AFTER the credit gate (§4.6.1a ordering)', () => {
  /*
   * 🔴 Resolving a rung reads the active Marketplace price list, and `getPlatformModel` THROWS while
   * `LLM_MODEL` names a model the list cannot price — the normal transient state mid-repricing. Put
   * this block above the gate and an out-of-credits user gets the operator's config error instead of
   * their 402: a 500 where a priced, describable refusal belongs, on a path that must always refuse
   * cleanly. The ordering is the whole protection, and nothing else can observe it.
   */
  const gateAt = proxy.indexOf('checkCreditGate({');
  const tiersAt = proxy.indexOf('getModelTiers(');
  const decisionAt = proxy.indexOf('decideModelTier({');
  const tierModelAt = proxy.indexOf('getTierModel(');

  it('CONTROL — every anchor was found in the stripped source', () => {
    expect(gateAt).toBeGreaterThan(-1);
    expect(tiersAt).toBeGreaterThan(-1);
    expect(decisionAt).toBeGreaterThan(-1);
    expect(tierModelAt).toBeGreaterThan(-1);
  });

  it('resolves the ladder, decides the rung and resolves its model all after the gate', () => {
    expect(gateAt).toBeLessThan(tiersAt);
    expect(gateAt).toBeLessThan(decisionAt);
    expect(gateAt).toBeLessThan(tierModelAt);
  });

  it('keeps the ladder in order: resolve, then decide, then resolve the chosen rung’s model', () => {
    expect(tiersAt).toBeLessThan(decisionAt);
    expect(decisionAt).toBeLessThan(tierModelAt);
  });

  /* The gate's refusal must still be the FIRST thing that can end the turn — a 402 before any config. */
  it('throws the 402 before the ladder block begins', () => {
    const refusal = proxy.indexOf('statusCode = 402');

    expect(refusal).toBeGreaterThan(-1);
    expect(refusal).toBeGreaterThan(gateAt);
    expect(refusal).toBeLessThan(tiersAt);
  });
});

describe('decideModelTier is handed the whole ladder and the real balance', () => {
  const args = callArgs(proxy, 'decideModelTier');

  /*
   * The DECISION's rules are pinned in `premium.spec.ts` against the pure function. What that cannot
   * see is a proxy that calls it with a hardcoded ladder or a constant balance — every rung would then
   * be granted or refused by something other than the user's credits, silently, on every generation.
   */
  it('receives the resolved ladder, not a literal', () => {
    expect(args).toMatch(/[{,]\s*tiers\s*[,}]/);
  });

  it('receives the gate’s balance — the fact eligibility is derived from', () => {
    expect(args).toContain('balance:');
    expect(args).toMatch(/balance:[^,]*gate\.balance/);
  });

  it('receives the requested rung from the request, not a constant wearing its name', () => {
    expect(args).toMatch(/requested:\s*requestedTier\b/);
  });

  /*
   * BYOK is charged zero, so its balance is not a credit fact at all. Passing the platform balance on
   * that path would make a Pro user's platform credits decide which rung their OWN key runs.
   */
  it('zeroes the balance on the BYOK path rather than passing a platform number', () => {
    expect(args).toMatch(/gate\.mode === 'byok' \? 0 :/);
  });
});

describe('the requested rung: tier wins, the legacy boolean still works, BYOK short-circuits', () => {
  const requestedTier = declaration(proxy, 'requestedTier');

  /*
   * 🔴 THE LEGACY ALIAS IS LOAD-BEARING AND ITS REMOVAL IS SILENT. A browser holding the previous
   * bundle keeps sending `premium: true` across a deploy; drop the fallback and that user is served
   * the standard model with nothing anywhere saying so — they simply stop getting what they chose.
   * This assertion exists so a future cleanup that "removes the dead boolean" fails loudly instead.
   */
  it('keeps the deprecated `premium` boolean as an alias for the premium rung', () => {
    expect(requestedTier).toContain('request.premium');
    expect(requestedTier).toMatch(/request\.premium\s*\?\s*'premium'\s*:\s*'standard'/);
  });

  /* `tier` outranks it — a client sending both is a client mid-upgrade, and the enum is the newer fact. */
  it('prefers the explicit tier id over the legacy boolean', () => {
    expect(requestedTier).toMatch(/request\.tier\s*\?\?/);
    expect(requestedTier.indexOf('request.tier')).toBeLessThan(requestedTier.indexOf('request.premium'));
  });

  /*
   * BYOK SHORT-CIRCUITS TO STANDARD. The user's own key pays, so there is no platform rung to buy —
   * `request.model` is already the honored choice on that path (§4.6.1). Without the short-circuit a
   * BYOK user's `tier` would resolve a PLATFORM rung's model and hand it to their key: the wrong model
   * on the wrong account, and `getTierModel` running for a rung nobody is paying the platform for.
   */
  it('forces standard on the BYOK path', () => {
    expect(requestedTier).toMatch(/useByok\s*\?\s*'standard'\s*:/);
  });

  /* And the resolved model honors BYOK ahead of any rung — the same precedence, one line down. */
  it('lets the BYOK model win over every rung when the model is finally resolved', () => {
    const model = declaration(proxy, 'model');

    expect(model).toMatch(/const model =\s*byokModel \?\?/);

    /*
     * Whitespace-tolerant: the arguments grew (`getTierModel` gained the selected provider under
     * `AUTO_MODEL_SELECT`) and prettier wrapped the line, which broke a literal `toContain` while the
     * PRECEDENCE this test is named for was untouched. A source scan that fails on reformatting
     * teaches people to loosen it rather than read it.
     */
    expect(model).toMatch(
      /tierDecision\.tier === 'standard'\s*\?\s*standardModel\s*:\s*getTierModel\(tierDecision\.tier/,
    );
  });

  /* The standard rung is the platform model — and BYOK skips resolving it at all (§4.6.1). */
  it('skips getPlatformModel entirely on the BYOK-with-a-model path', () => {
    expect(declaration(proxy, 'standardModel')).toMatch(/byokModel \?\? getPlatformModel\(/);
  });
});

describe('the declined notice names the rung the user actually asked for', () => {
  const tierNotice = declaration(proxy, 'tierNotice');

  /*
   * A hardcoded "premium" here would quote a declined SuperMax user Premium's threshold and Premium's
   * name — a wrong number in the one message whose entire job is telling them what it costs to unlock.
   * The label and the threshold both come from the row the user requested.
   */
  it('reads the requested row’s own label and threshold', () => {
    expect(tierNotice).toContain('tierDeclinedNotice(requestedRow.label, requestedRow.minimumCredits)');
    expect(tierNotice).not.toMatch(/'premium'/);
  });

  /*
   * Only `below_minimum` gets a notice: the other refusals are not the user's to act on.
   *
   * ⚠️ The `toMatch` alone is NOT enough, and that gap was measured: widening the condition to
   * `(reason === 'below_minimum' || reason === 'creation_turn')` still satisfies it, and it tells a
   * 5,000-credit user on a first build turn "SuperMax needs at least 1,500 credits" — a wrong,
   * misleading notice on precisely the turn the rule says must be SILENT. Typecheck, lint and all
   * 3,946 tests stayed green under that mutation. So the other four reasons are named and excluded:
   * an assertion about which condition fires must also say which conditions must not.
   */
  it('fires only when the rung was declined for want of credits', () => {
    expect(tierNotice).toMatch(/tierDecision\.reason === 'below_minimum'/);

    for (const reason of ['creation_turn', 'unavailable', 'standard_requested', 'sufficient_credits']) {
      expect(tierNotice, `a ${reason} refusal must not produce a credits notice`).not.toContain(reason);
    }
  });

  /*
   * A notice that is computed and never handed to the route is the same defect as no notice at all —
   * and it is a quieter one, since the variable still exists and reads as wired. Nothing named this
   * line, so dropping `?? tierNotice` passed the whole suite (only `no-unused-vars` objected, and only
   * incidentally). The declined user is told nothing and the generation looks entirely normal.
   */
  it('is actually handed to the route on the generation handle', () => {
    expect(proxy).toMatch(/notice:\s*byok\.notice \?\? tierNotice/);
  });

  it('looks the row up by the rung that was REQUESTED, not the one that ran', () => {
    expect(declaration(proxy, 'requestedRow')).toContain('row.id === requestedTier');
  });
});

describe('the rung that ran is recorded, never inferred from the model', () => {
  /*
   * A model string can identify a rung only while every rung names a different model — which stops
   * being true the moment an operator points two rungs at one id (ordinary during a migration) — and
   * it can NEVER distinguish "the user chose standard" from "the user chose SuperMax and was declined
   * for credits". Same model, very different facts about the ladder, and the second one is the whole
   * reason the reason code exists.
   */
  it('carries the tier and its reason onto the generation record', () => {
    expect(proxy).toMatch(/tier:\s*tierDecision\.tier/);
    expect(proxy).toMatch(/tierReason:\s*tierDecision\.reason/);
  });

  it('logs the rung beside the model, with the reason whenever it is not a plain standard turn', () => {
    const tierLog = declaration(proxy, 'tierLog');

    expect(tierLog).toContain('tier=standard');
    expect(tierLog).toContain('${tierDecision.tier}(${tierDecision.reason})');
    expect(proxy).toContain('model=${model} ${tierLog}');
  });
});

/* ====================================================== 3. the ROUTE half (T7) — driven, not scanned */

/**
 * A generation that ran, with every field the route reads. Defaults describe the case the whole
 * section is about: the user asked for a rung and got a DIFFERENT one, so the requested value and the
 * value that ran can never be confused for each other by accident.
 */
function fakeGeneration(overrides: Partial<AgentGeneration> = {}): AgentGeneration {
  return {
    generationId: 'gen_route_1',
    promptVersionId: 'pv_route_1',
    model: 'claude-sonnet-5',
    tier: 'standard',
    tierReason: 'below_minimum',
    blocksLoaded: [],
    historyStats: { messages: 0, chars: 0, attachments: 0, attachmentTokens: 0, maxTurns: 8 },
    discussMode: false,
    statusKind: 'edit',
    currentActivity: () => null,
    toolContext: { loaded: new Set<string>() },
    usage: Promise.resolve({
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    }),
    settlement: Promise.resolve({ creditsCharged: 0, balanceAfter: 0 }),

    /*
     * The route AWAITS this before writing `agentMeta` (§fail-loud: how the turn ended, for the user).
     * A fixture missing it leaves the annotation unwritten and every assertion in this file reads
     * `undefined` — which is what happened when it was added.
     */
    outcome: Promise.resolve({
      isFirstBuildTurn: false,
      finishReason: 'stop',
      forcedContinuation: false,
      unproductiveRescue: false,
      completionPassWroteFiles: false,
      wroteFiles: true,
      aborted: false,
    }),
    onMcpToolCall: vi.fn(),

    /* Preview dev-tools relay — the route subscribes before draining, so the double must offer it. */
    onPreviewToolCall: vi.fn(),
    onMediaTask: vi.fn(),
    ...overrides,

    /*
     * Spread LAST is wrong for a generator — an override would be a called generator, not a factory —
     * so the stream is resolved after the spread: an override may supply chunks, the default supplies
     * one, and either way `textStream` is the live iterator the route drains.
     */
    textStream: (overrides.textStream ??
      (async function* () {
        yield { type: 'text' as const, value: 'done' };
      })()) as AgentGeneration['textStream'],
  } as AgentGeneration;
}

/** POST a body at the real route and read the whole data stream back as text. */
async function postToAgentRoute(body: Record<string, unknown>): Promise<string> {
  const response = await (
    agentRouteAction as unknown as (args: {
      request: Request;
      context: unknown;
      params: Record<string, string>;
    }) => Promise<Response>
  )({
    request: new Request('http://localhost/api/agent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ id: 'm1', role: 'user', content: 'hi' }], ...body }),
    }),
    context: {},
    params: {},
  });

  expect(response.status).toBe(200);

  return response.text();
}

/**
 * The `agentMeta` message annotation as it went on the wire.
 *
 * Message annotations are `8:[…]` parts in the AI SDK's data-stream protocol. Read from the RESPONSE
 * rather than from a spy on `writeMessageAnnotation`, because the thing under test is what the client
 * receives — a value that is computed and never written is the same defect as a wrong one.
 */
function annotationFromStream(wire: string, type: string): Record<string, unknown> {
  const annotations = wire
    .split('\n')
    .filter((line) => line.startsWith('8:'))
    .flatMap((line) => JSON.parse(line.slice(2)) as unknown[]);

  const found = annotations.find(
    (entry) => typeof entry === 'object' && entry !== null && (entry as { type?: string }).type === type,
  ) as { value: Record<string, unknown> } | undefined;

  expect(found, `the stream carried no ${type} annotation`).toBeDefined();

  return found!.value;
}

function agentMetaFromStream(wire: string): Record<string, unknown> {
  return annotationFromStream(wire, 'agentMeta');
}

describe('the route hands the ladder its inputs and reports the rung that RAN', () => {
  beforeEach(() => {
    routeMocks.requireVerifiedUser.mockReset();
    routeMocks.runAgentGeneration.mockReset();
    routeMocks.requireVerifiedUser.mockResolvedValue({ id: 'user_1', email: 'dev@example.com' });
    routeMocks.runAgentGeneration.mockResolvedValue(fakeGeneration());
  });

  /** What `runAgentGeneration` was actually called with. */
  const proxyCall = () => routeMocks.runAgentGeneration.mock.calls[0][0] as Record<string, unknown>;

  it('CONTROL — the drive reaches the proxy at all, with the request it was given', async () => {
    await postToAgentRoute({ chatId: 'c1' });

    expect(routeMocks.requireVerifiedUser).toHaveBeenCalledTimes(1);
    expect(routeMocks.runAgentGeneration).toHaveBeenCalledTimes(1);
    expect(proxyCall().chatId).toBe('c1');
    expect(proxyCall().messages).toHaveLength(1);
  });

  /*
   * 🔴 The rung the user picked has to SURVIVE the boundary. Drop this one line and every request is
   * a standard request: the picker still renders, the pill still says SuperMax, the ladder in the
   * proxy still works perfectly — and nobody is ever served anything but the free rung, with nothing
   * throwing and the bill going DOWN, which reads as a cheaper turn rather than a broken feature.
   */
  it('forwards the requested tier to the proxy, intact', async () => {
    await postToAgentRoute({ tier: 'supermax' });
    expect(proxyCall().tier).toBe('supermax');
  });

  /*
   * Verbatim: narrowing is `decideModelTier`'s job, and a boundary that "helpfully" normalises here
   * is a second copy of the resolution rule that will drift from the one the decision actually uses.
   */
  it('forwards an unrecognised tier verbatim rather than sanitising it at the boundary', async () => {
    await postToAgentRoute({ tier: 'ultramax' });
    expect(proxyCall().tier).toBe('ultramax');
  });

  /*
   * 🔴 THE LEGACY ALIAS IS LOAD-BEARING AND ITS REMOVAL IS SILENT. A browser holding the previous
   * bundle keeps posting `premium: true` across a deploy; drop the forward and that user is served
   * the standard model with nothing anywhere saying so. `proxy.ts`'s half of this is pinned above —
   * this is the half that would let a future "remove the dead boolean" cleanup pass every test.
   */
  it('still forwards the deprecated premium boolean', async () => {
    await postToAgentRoute({ premium: true });

    expect(proxyCall().premium).toBe(true);
    expect(proxyCall().tier).toBeUndefined();
  });

  it('forwards both when a client mid-upgrade sends both, and lets the proxy pick', async () => {
    await postToAgentRoute({ tier: 'supermax', premium: true });

    expect(proxyCall().tier).toBe('supermax');
    expect(proxyCall().premium).toBe(true);
  });

  /*
   * 🔴 THE ANNOTATION NAMES WHAT RAN, NOT WHAT WAS ASKED FOR. The request here says `supermax`; the
   * generation ran `standard` because the user was below the threshold. Reading `body.tier` instead
   * of `generation.tier` would put "supermax" on a turn that was billed at the free rung — the client
   * pill, the `/context` report and anyone reading a transcript would all be told the user got a rung
   * they were declined. The two values are deliberately different in every case in this block.
   */
  it('reports the rung that RAN, never the rung that was requested', async () => {
    const meta = agentMetaFromStream(await postToAgentRoute({ tier: 'supermax' }));

    expect(meta.tier).toBe('standard');
    expect(meta.tier).not.toBe('supermax');
  });

  it('reports WHY — the reason comes from the decision, and a request has no reason to give', async () => {
    const meta = agentMetaFromStream(await postToAgentRoute({ tier: 'premium' }));
    expect(meta.tierReason).toBe('below_minimum');
  });

  /*
   * And the same on a turn that was GRANTED, so the assertion above cannot be satisfied by a route
   * that hardcodes `standard` — the pair is what makes either one mean something.
   */
  it('CONTROL — a granted rung is reported as itself', async () => {
    routeMocks.runAgentGeneration.mockResolvedValue(
      fakeGeneration({ tier: 'premium', tierReason: 'sufficient_credits', model: 'claude-fable-5' }),
    );

    const meta = agentMetaFromStream(await postToAgentRoute({ tier: 'premium' }));

    expect(meta.tier).toBe('premium');
    expect(meta.tierReason).toBe('sufficient_credits');
    expect(meta.model).toBe('claude-fable-5');
  });

  /*
   * The legacy path must be observable too: a `premium: true` client that gets declined has to be
   * able to tell, and it has no `tier` of its own to compare against.
   */
  it('reports the rung on a legacy premium request as well', async () => {
    routeMocks.runAgentGeneration.mockResolvedValue(
      fakeGeneration({ tier: 'premium', tierReason: 'sufficient_credits', model: 'claude-opus-5' }),
    );

    const meta = agentMetaFromStream(await postToAgentRoute({ premium: true }));

    expect(meta.tier).toBe('premium');
    expect(meta.tierReason).toBe('sufficient_credits');
  });

  /* The tier rides WITH the rest of the meta, not instead of it — the annotation is one object. */
  it('keeps the existing agentMeta fields alongside the tier', async () => {
    const meta = agentMetaFromStream(await postToAgentRoute({ tier: 'premium' }));

    expect(meta.generationId).toBe('gen_route_1');
    expect(meta.promptVersionId).toBe('pv_route_1');
    expect(meta.model).toBe('claude-sonnet-5');
  });

  /*
   * 🔴 THE DECLINED-TIER NOTICE MUST REACH THE WIRE, and until this test existed it did not have to.
   *
   * The chain is three links long — `tierDeclinedNotice` builds the string (`premium.ts`), the proxy
   * puts it on the handle as `byok.notice ?? tierNotice` (pinned above), and the route writes it onto
   * the `credits` annotation. The first two links were pinned and the THIRD was not: deleting
   * `notice: generation.notice ?? null` from the route left the full suite green at 3,965 tests. The
   * user who asked for SuperMax and could not afford it is then told nothing at all, on a turn that
   * otherwise looks completely ordinary — the silent half of "declined, never blocked" (§4.6.1).
   *
   * Read off the RESPONSE BYTES like the agentMeta cases, for the same reason: a notice that is
   * computed and never written is the same defect as a wrong one.
   */
  it('puts the declined-tier notice on the credits annotation', async () => {
    const notice = 'The SuperMax model needs at least 1,500 credits — this build used the standard model.';

    routeMocks.runAgentGeneration.mockResolvedValue(fakeGeneration({ notice }));

    const credits = annotationFromStream(await postToAgentRoute({ tier: 'supermax' }), 'credits');

    expect(credits.notice).toBe(notice);
  });

  /*
   * CONTROL — the field is not simply always populated. A turn that was granted (or never asked) must
   * carry `null`, or the assertion above would pass against a route that hardcodes a string.
   */
  it('CONTROL — a turn with nothing to say carries a null notice', async () => {
    routeMocks.runAgentGeneration.mockResolvedValue(
      fakeGeneration({ tier: 'premium', tierReason: 'sufficient_credits' }),
    );

    const credits = annotationFromStream(await postToAgentRoute({ tier: 'premium' }), 'credits');

    expect(credits.notice).toBeNull();
  });

  /* The settled numbers still ride the same annotation — the notice must not have displaced them. */
  it('keeps the settled credit numbers alongside the notice', async () => {
    routeMocks.runAgentGeneration.mockResolvedValue(
      fakeGeneration({
        notice: 'declined',
        settlement: Promise.resolve({ creditsCharged: 42, balanceAfter: 958, savings: null }),
      }),
    );

    const credits = annotationFromStream(await postToAgentRoute({ tier: 'supermax' }), 'credits');

    expect(credits).toMatchObject({ creditsCharged: 42, balanceAfter: 958, notice: 'declined' });
  });
});

/* ---------------------------------------------- the two things a request cannot express: a scan */

const routeRaw = readFileSync(join(REPO, 'app/routes/api.agent.ts'), 'utf-8');

/*
 * 🔴 STRIP THE COMMENTS. T7's own doc comments spell out `tier`, `premium` and the tier union in
 * prose, directly above the code they describe — and the union one is not hypothetical: the
 * "no narrowed union at the boundary" assertion below is satisfied by the raw file and refuted by the
 * stripped one, so without the strip it reports all-clear on a file that HAS been narrowed. A comment
 * cannot fail (`shell-strip.ts`), and a scan that reads one is reading documentation, not behaviour.
 */
const route = routeRaw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** The `value: { … }` of one `writeMessageAnnotation`, located by its `type` and brace-matched. */
function annotationValue(source: string, type: string): string {
  const at = source.indexOf(`'${type}'`);

  if (at < 0) {
    return '';
  }

  const open = source.indexOf('value: {', at);

  if (open < 0) {
    return '';
  }

  const brace = source.indexOf('{', open);
  let depth = 0;

  for (let i = brace; i < source.length; i++) {
    if (source[i] === '{') {
      depth++;
    } else if (source[i] === '}' && --depth === 0) {
      return source.slice(brace, i + 1);
    }
  }

  return '';
}

describe('CONTROLS — the route scan can still see the code it judges', () => {
  it('reads a real, non-trivial api.agent.ts', () => {
    expect(route.length).toBeGreaterThan(5_000);
    expect(route).toContain('export async function action');
  });

  it('strips comments, so the prose describing the tier fields is not the tier fields', () => {
    // Each of these sentences names a token an assertion below depends on. None may survive the strip.
    expect(routeRaw).toContain('never the one that was requested');
    expect(route).not.toContain('never the one that was requested');

    expect(routeRaw).toContain('still accepted as an alias');
    expect(route).not.toContain('still accepted as an alias');

    // The sentence that explains the boundary type, in the comment that sits directly above it.
    expect(routeRaw).toContain('untrusted browser value');
    expect(route).not.toContain('untrusted browser value');
  });

  it('extracts real, non-empty regions for every scan below', () => {
    expect(callArgs(route, 'runAgentGeneration')).toContain('messages:');
    expect(annotationValue(route, 'agentMeta')).toContain('generationId:');
  });
});

describe('the request body accepts an UNTRUSTED tier, and keeps the legacy alias', () => {
  /*
   * 🔴 `tier?: string`, never `tier?: ModelTierId`. This value arrives in a browser body on the
   * platform's credit pool, and typing it as the narrowed union is a CAST, not a check — TypeScript
   * erases, so the only thing it would change is that `decideModelTier` (which resolves anything
   * unrecognised DOWN to standard, and is where the rule actually lives) would look redundant to the
   * next reader. A typo would then be an "authorized" value with nothing narrowing it.
   */
  it('types tier as a plain string at the boundary', () => {
    expect(route).toMatch(/\btier\?:\s*string;/);
  });

  it('does not narrow or cast it to a tier id at the boundary', () => {
    expect(route).not.toMatch(/\btier\?:\s*ModelTierId/);
    expect(route).not.toMatch(/\btier\?:\s*'standard'/);
    expect(route).not.toMatch(/body\.tier as ModelTierId/);

    /*
     * No tier union survives anywhere in the CODE — and this is the assertion that makes the comment
     * strip load-bearing rather than decorative: the doc comment above the field spells the union out
     * in prose, so the raw file contains it and only the stripped file can refute it. Asserted as a
     * pair, because an assertion that would pass on the unstripped source is not testing the strip.
     */
    expect(routeRaw).toContain("'standard' | 'premium'");
    expect(route).not.toContain("'standard' | 'premium'");
  });

  /* The deprecated alias is still part of the accepted shape — dropping the field drops the alias. */
  it('still declares the deprecated premium boolean', () => {
    expect(route).toMatch(/\bpremium\?:\s*boolean;/);
  });
});

describe('the forward and the annotation read from the right side of the ladder', () => {
  const forwarded = callArgs(route, 'runAgentGeneration');
  const meta = annotationValue(route, 'agentMeta');

  it('forwards both the tier and the legacy boolean, from the body', () => {
    expect(forwarded).toMatch(/tier:\s*body\.tier\b/);
    expect(forwarded).toMatch(/premium:\s*body\.premium\b/);
  });

  /*
   * The pair that the live drive above proves behaviourally, pinned in the source too: a scan cannot
   * tell "supermax" from "standard", but it CAN say that the only thing this annotation may read is
   * the generation. `body` is not in scope in `streamGeneration` at all — which is exactly why this is
   * cheap to get wrong the day someone threads the request in for some other reason.
   */
  it('reports the tier and its reason from the generation, never from the request', () => {
    expect(meta).toMatch(/tier:\s*generation\.tier\b/);
    expect(meta).toMatch(/tierReason:\s*generation\.tierReason\b/);
    expect(meta).not.toContain('body.tier');
    expect(meta).not.toContain('body.premium');
  });
});
