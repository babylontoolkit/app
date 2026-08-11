/**
 * THE LADDER'S FEEDBACK LOOP IS ENTIRELY IN THE PROXY, AND NOTHING ELSE CAN SEE IT.
 *
 * `selectPlatformProvider` is pure and exhaustively tested next door, but it is only as good as the
 * health signal it reads — and that signal is written at two points inside `runAgentGeneration`, which
 * cannot be constructed in a unit test (it boots the prompt store, the ledger and a provider). A proxy
 * that forgets `recordProviderFailure` produces perfectly healthy generations that simply never fail
 * over; one that forgets `recordProviderSuccess` leaves a stale cooldown standing and holds traffic off
 * the cheapest rung — and its warm prefix — long after it recovered. Both are silent, and both cost
 * money in the direction the feature exists to avoid.
 *
 * So this is a source scan — the same instrument as `budgets-wiring.spec.ts` and `skill-selection.spec.ts`
 * — and, like those, it carries CONTROLS: a scanner whose pattern silently stops matching reports a
 * clean bill of health forever.
 *
 * ⚠️ The behavioural half of the wiring lives in `provider-select.spec.ts`: `getPlatformConfig` going
 * through `resolvePlatformProvider` is asserted there by observing the provider it returns, which is
 * stronger than any regex. What cannot be observed without a live generation is asserted here.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

/** These identifiers are quoted constantly in the comments that explain them; prose proves nothing. */
const codeOnly = (source: string) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('//'))
    .join('\n');

const proxy = () => codeOnly(read('app/lib/.server/agent/proxy.ts'));
const config = () => codeOnly(read('app/lib/.server/agent/config.ts'));

describe('the proxy feeds the ladder its health signal', () => {
  it('imports the recorders from provider-select', () => {
    expect(proxy()).toMatch(/import \{[^}]*recordProviderFailure[^}]*\} from '\.\/provider-select'/);
    expect(proxy()).toMatch(/import \{[^}]*recordProviderSuccess[^}]*\} from '\.\/provider-select'/);
  });

  it('records a failure against the provider that actually served the turn', () => {
    expect(proxy()).toMatch(/recordProviderFailure\(config\.provider, Date\.now\(\)\)/);
  });

  /*
   * 🔴 The signal stays exactly as narrow as the evidence. `shouldRetryGeneration` has already
   * established that the gateway broke BEFORE producing a billed token — a fact about the GATEWAY.
   * A second call site keyed on the generic `failed` flag would cool a healthy rung for a zod
   * violation, an unproductive turn or a refusal, moving every following turn onto a cold prefix
   * (~8x one prefix in cache writes) for something the provider did not do.
   */
  it('records a failure from ONE place only — the retry site', () => {
    expect(proxy().match(/recordProviderFailure\(/g)).toHaveLength(1);
  });

  it('places that call on the retry path, after the retry decision has been made', () => {
    const source = proxy();
    const decision = source.indexOf('shouldRetryGeneration({');
    const retried = source.indexOf('retried = true');
    const failure = source.indexOf('recordProviderFailure(');

    expect(decision, 'shouldRetryGeneration call not found').toBeGreaterThan(-1);
    expect(retried, 'the retried flag not found').toBeGreaterThan(-1);
    expect(failure).toBeGreaterThan(decision);
    expect(failure, 'the cooldown must only be armed once we have committed to a retry').toBeGreaterThan(retried);
  });

  /*
   * A gateway that STREAMED is healthy whatever became of the turn afterwards. Keyed on BILLED OUTPUT
   * rather than on `failed`, for the mirror-image reason the failure above is keyed on the retry: our
   * own downstream failures are not evidence against the provider.
   */
  it('records a success only when the gateway actually produced billed output', () => {
    expect(proxy()).toMatch(/if \(totals\.completionTokens > 0\) \{\s*recordProviderSuccess\(config\.provider\);/);
  });

  it('records that success from ONE place only', () => {
    expect(proxy().match(/recordProviderSuccess\(/g)).toHaveLength(1);
  });

  /*
   * In the settlement `finally`, so it cannot be missed on an error path — a turn that streamed and
   * then threw is still proof the gateway is up, and it is exactly the turn most likely to have armed
   * a cooldown a moment earlier.
   */
  it('records it in the finally block, not only on the happy path', () => {
    const source = proxy();
    const finallyAt = source.lastIndexOf('} finally {', source.indexOf('recordProviderSuccess('));

    expect(finallyAt, 'no finally block precedes the success call').toBeGreaterThan(-1);
  });
});

/**
 * 🔴 ONE RESOLUTION PER GENERATION. `config.provider` flows to the wire AND to `settleGeneration`, so a
 * second resolution anywhere later could disagree — and a turn served by gateway A and billed at
 * gateway B's rates is a mis-bill with no honest correction available.
 */
describe('the model is validated against the gateway that will serve it', () => {
  it('resolves the config exactly once', () => {
    expect(proxy().match(/getPlatformConfig\(/g)).toHaveLength(1);
  });

  it('passes the resolved provider to getPlatformModel rather than letting it re-derive', () => {
    expect(proxy()).toMatch(/getPlatformModel\(request\.context, config\.provider\)/);
  });

  it('never calls getPlatformModel without the override', () => {
    const bare = proxy().match(/getPlatformModel\([^)]*\)/g) ?? [];

    expect(bare.length).toBeGreaterThan(0);

    for (const call of bare) {
      expect(call, 're-deriving the provider here validates against the wrong price table').toContain(
        'config.provider',
      );
    }
  });

  it('getPlatformConfig goes through the ladder resolver', () => {
    expect(config()).toMatch(/provider: resolvePlatformProvider\(context\)/);
  });

  /* The ladder is the ONLY thing allowed to widen the answer — one door, so the flag cannot be bypassed. */
  it('resolvePlatformProvider is the single caller of the selector', () => {
    expect(config().match(/selectPlatformProvider\(/g)).toHaveLength(1);
  });
});

/**
 * CONTROLS. Every assertion above is a regex against files that are edited constantly. If one silently
 * stops matching, the suite goes green on a proxy that records nothing and a ladder that never fires.
 */
describe('CONTROLS — the scanner still reads the files it thinks it does', () => {
  it('finds the proxy, and it is a real module', () => {
    const source = proxy();

    expect(source.length).toBeGreaterThan(10_000);
    expect(source).toContain('runAgentGeneration');
  });

  it('finds the config, and it is a real module', () => {
    const source = config();

    expect(source.length).toBeGreaterThan(1_000);
    expect(source).toContain('getPlatformConfig');
  });

  it('strips comments rather than matching prose', () => {
    const stripped = codeOnly(
      ['/* recordProviderFailure(config.provider, Date.now()) */', 'const real = 1;', '// recordProviderSuccess('].join(
        '\n',
      ),
    );

    expect(stripped).toContain('const real = 1;');
    expect(stripped).not.toContain('recordProviderFailure');
    expect(stripped).not.toContain('recordProviderSuccess');
  });

  /*
   * The stripper must be doing its job on the REAL file, not just on the synthetic sample above. Both
   * counted call sites sit directly beneath a long block comment arguing for them; if the stripper
   * regressed, the "exactly once" assertions would start counting that prose and would pass for a
   * proxy that calls neither recorder.
   */
  it('strips the actual comment blocks that wrap the two call sites', () => {
    const raw = read('app/lib/.server/agent/proxy.ts');
    const stripped = proxy();

    for (const phrase of ['THE GATEWAY IS THE SUSPECT HERE', 'A gateway that STREAMED is a healthy gateway']) {
      expect(raw, 'the rationale comment has been reworded — re-point this control').toContain(phrase);
      expect(stripped).not.toContain(phrase);
    }

    expect(stripped.length).toBeLessThan(raw.length);
  });

  /* The emptiness guards above only mean something if these constructs are locatable at all. */
  it('locates every construct it asserts on', () => {
    const source = proxy();

    expect(source).toContain('shouldRetryGeneration({');
    expect(source).toContain('} finally {');
    expect(source).toMatch(/getPlatformModel\([^)]*\)/);
    expect(config()).toMatch(/selectPlatformProvider\(/);
  });
});

/**
 * 🔴 THE PRICES ARE LOADED FOR EVERY GATEWAY THE LADDER COULD PICK — NOT JUST `LLM_PROVIDER`.
 *
 * `canPrice` (the ladder's money gate) and `ratesFor` (settlement) both read the marketplace lists
 * SYNCHRONOUSLY; the only thing that populates them is the async `ensureMarketPrices` at a doorway.
 * Both doorways — `runAgentGeneration` and `/api/me` — used to ensure `marketPriceProvidersFor(
 * getPlatformProvider(context))`, i.e. `LLM_PROVIDER` alone. That was correct while the gateway was
 * fixed and silently wrong the moment auto-select could choose another one: the SELECTED gateway would
 * be gated, and then billed, from its BAKED table with the operator's promoted list ignored.
 *
 * Nothing throws when this regresses. No request fails, no log fires, and the only trace is a credit
 * figure that is quietly derived from the wrong price list — which is why the set has to be read from
 * the source. `providersToPrice`'s own behaviour is pinned in `provider-select.spec.ts`; what cannot
 * be observed without a live generation is whether these two call sites still ASK it.
 */
const apiMe = () => codeOnly(read('app/routes/api.me.ts'));

describe('both doorways price the whole chain before anything is chosen or billed', () => {
  it('the proxy imports providersToPrice from the config', () => {
    expect(proxy()).toMatch(/import \{[\s\S]*?providersToPrice[\s\S]*?\} from '\.\/config'/);
  });

  it('the proxy builds its ensure set from providersToPrice', () => {
    expect(proxy()).toMatch(/providersToPrice\(request\.context\)/);
  });

  it('/api/me builds its ensure set from providersToPrice', () => {
    expect(apiMe()).toMatch(/providersToPrice\(context\)/);
  });

  /*
   * 🔴 The regression, stated as an ABSENCE. Re-deriving the gateway here — the exact expression both
   * doorways used to hold — narrows the set back to `LLM_PROVIDER` and prices the ladder's other rungs
   * from their baked tables. It is a one-line edit that reads like a simplification.
   */
  it.each([
    ['the proxy', proxy],
    ['/api/me', apiMe],
  ])('%s never re-derives the gateway inside the ensure set', (_label, source) => {
    expect(source()).not.toMatch(/marketPriceProvidersFor\(\s*getPlatformProvider\(/);
  });

  /*
   * Whatever the set is, it is what `ensureMarketPrices` is actually fed — a computed-and-dropped set
   * would satisfy every assertion above and load nothing.
   */
  it.each([
    ['the proxy', proxy],
    ['/api/me', apiMe],
  ])('%s feeds that set to ensureMarketPrices', (_label, source) => {
    const text = source();
    const setAt = text.indexOf('providersToPrice(');
    const ensureAt = text.indexOf('ensureMarketPrices(', setAt);

    expect(setAt).toBeGreaterThan(-1);
    expect(ensureAt, 'the set is computed and never handed to the loader').toBeGreaterThan(setAt);
  });

  /*
   * PRICES FIRST, THEN THE CHOICE THAT DEPENDS ON THEM. `getPlatformConfig` runs the ladder, whose
   * `canPrice` gate reads the lists synchronously — so ensuring them afterwards judges every rung from
   * whatever happened to be cached, which on a cold process is the baked table.
   */
  it('the proxy awaits the prices before it resolves the platform config', () => {
    const source = proxy();
    const pricedAt = source.indexOf('providersToPrice(');
    const configAt = source.indexOf('getPlatformConfig(');

    /* Both anchors first: a missing call yields -1, which compares as "early" and passes vacuously. */
    expect(pricedAt).toBeGreaterThan(-1);
    expect(configAt).toBeGreaterThan(-1);
    expect(pricedAt).toBeLessThan(configAt);
  });
});

/**
 * 🔴 THE PAID RUNG IS VALIDATED AGAINST THE GATEWAY THAT WILL SERVE IT.
 *
 * `getTierModel` gained a provider override for the same reason `getPlatformModel` did: with the
 * ladder on, the gateway is chosen PER REQUEST, so a caller holding `config.provider` must say so or
 * it silently asks a DIFFERENT provider's price table than the one about to spend the money.
 *
 * ⚠️ Read `getTierModel`'s own comment before strengthening this: for an ENABLED rung the lookup it
 * guards cannot fail on any provider (`providerRates` gap-fills every rung's model into every table),
 * so the argument is not observable through the function's public behaviour — see the note in
 * `model-tier-config.spec.ts`. A source scan is therefore the only instrument that can see it at all.
 */
describe('the paid rung is resolved against the selected gateway', () => {
  /*
   * Whitespace-tolerant on purpose: prettier already wrapped this call across lines once, which broke a
   * literal `toContain` while the property was untouched. A scan that fails on reformatting teaches
   * people to loosen it rather than read it.
   */
  it('passes config.provider to getTierModel', () => {
    expect(proxy()).toMatch(/getTierModel\(\s*tierDecision\.tier\s*,\s*request\.context\s*,\s*config\.provider\s*\)/);
  });

  it('never calls getTierModel without the override', () => {
    const calls = proxy().match(/getTierModel\([\s\S]{0,120}?\)/g) ?? [];

    expect(calls.length, 'the ladder block no longer resolves a rung model').toBeGreaterThan(0);

    for (const call of calls) {
      expect(call, 're-deriving the gateway here validates against the wrong price table').toContain('config.provider');
    }
  });
});

/**
 * CONTROLS for the two blocks above. Same reason as the set below them: a regex that silently stops
 * matching reports a clean bill of health forever, and two of these assertions are ABSENCES — which
 * pass trivially against an empty string.
 */
describe('CONTROLS — the doorway scanner reads real code', () => {
  it('finds /api/me, and it is a real route module', () => {
    const source = apiMe();

    expect(source.length).toBeGreaterThan(1_000);
    expect(source).toContain('export async function loader');
    expect(source).toContain('ensureMarketPrices');
  });

  /*
   * The absence assertions are only meaningful if the scanner CAN see this shape. Proving the pattern
   * matches the old expression verbatim is what stops it from being an assertion about nothing.
   */
  it('the forbidden expression is one the scanner can actually match', () => {
    expect(codeOnly('const x = marketPriceProvidersFor(getPlatformProvider(context));')).toMatch(
      /marketPriceProvidersFor\(\s*getPlatformProvider\(/,
    );
    expect(codeOnly('const y = marketPriceProvidersFor(\n  getPlatformProvider(request.context),\n);')).toMatch(
      /marketPriceProvidersFor\(\s*getPlatformProvider\(/,
    );
  });

  /* And that both files still contain the anchors the assertions are positioned against. */
  it('locates every construct these blocks assert on', () => {
    expect(proxy()).toContain('providersToPrice(');
    expect(proxy()).toContain('ensureMarketPrices(');
    expect(proxy()).toContain('getPlatformConfig(');
    expect(proxy()).toMatch(/getTierModel\(/);
    expect(apiMe()).toContain('providersToPrice(');
    expect(apiMe()).toContain('marketPriceProvidersFor(');
  });

  /*
   * `/api/me`'s prose argues for the whole-chain refresh in a block comment that quotes both function
   * names. Unstripped, the "builds its ensure set from providersToPrice" assertion would pass for a
   * route that only TALKS about it — the false all-clear this file exists to prevent.
   */
  it('strips /api/me’s rationale comment rather than matching it', () => {
    const raw = read('app/routes/api.me.ts');

    expect(raw, 'the rationale comment has been reworded — re-point this control').toContain(
      'The whole CHAIN, not just `LLM_PROVIDER`',
    );
    expect(apiMe()).not.toContain('The whole CHAIN, not just `LLM_PROVIDER`');
  });
});
