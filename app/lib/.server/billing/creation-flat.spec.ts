/**
 * The RETIREMENT of flat creation pricing (§4.4a, 2026-07-29), and the flat/cap levers that outlived it.
 *
 * Two things are pinned here, and they are deliberately different in kind:
 *
 * 1. **`CREATION_FLAT_CREDITS` is REFUSED, not ignored.** Under the project-first flow there is no
 *    creation TURN to price: New Project clones the pinned starter, installs it and serves it without
 *    running a generation at all, and carries its own flat charge at registration
 *    (`PROJECT_CREATE_CREDITS`, ledger reason `project_create`). An operator who leaves the old
 *    variable set is expressing a pricing intent nothing honours — the exact shape of the retired KIE
 *    price vars, and the reason that precedent exists: a price variable nothing reads is a mis-bill
 *    waiting to be believed. `getBillingConfig` throws a `NotConfiguredError` NAMING the replacement.
 *
 * 2. **`decideCredits`' `flat`/`maxCredits` levers and the gate's `minimumCredits` wall are KEPT** —
 *    pure, exported, tested money decisions with (as of the retirement) no production caller. Ceasing
 *    to PASS them was the pricing decision; deleting them would discard a tested capability the
 *    operator may want back, and an untested one is worse than an absent one. Their branches stay
 *    pinned by intent: charging a flat price on a BYOK or zero-usage generation is a silent mis-bill
 *    in one direction, and silently falling back to cost-derived is one in the other.
 *
 * The settlement block below still drives the real `FsLedger` end-to-end (flat debit lands, the note
 * names the pricing model, `rawCostUsd` stays the TRUE token-derived cost) — that is what makes the
 * retained lever genuinely retained rather than nominally so.
 *
 * Sibling to `billing.spec.ts` (that file is ~1,900 lines); same FsLedger/store setup, same env-scrub
 * posture — the `oauth.spec.ts` trap means the WHOLE precedence chain is scrubbed first, or a
 * developer with `CREATION_FLAT_CREDITS` in `.env.local` fails money assertions locally with CI green.
 * That trap is now sharper than it was: an unscrubbed value does not skew a number, it THROWS.
 */
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { creditsForUsage, DEFAULT_CREATION_FLAT_CREDITS, getBillingConfig, rawCostUsd, type TokenUsage } from './rates';
import { NotConfiguredError } from '~/lib/.server/env';
import { checkCreditGate, decideCredits, settleGeneration } from './gate';
import { FsLedger, setLedger } from './ledger';
import { setGenerationStore, type GenerationStore } from './generations';
import { invalidateMarketPricesCache } from './market-price-store';
import { CREATION_BRIEF_MARKER } from '~/types/creation';

let tmp: string;
let ledger: FsLedger;

/**
 * ⚠️ The `oauth.spec.ts` trap: `env()` falls back to `process.env` and vitest loads `.env.local`, so
 * an "empty" context is the developer's real configuration. Scrub the whole chain that feeds
 * `getBillingConfig` + `decideCredits`, not just the variable under test (`billing.spec.ts` carries
 * the twice-fired history of exactly this list going stale).
 */
const SCRUBBED_ENV = [
  'CREATION_FLAT_CREDITS',
  'BILLING_ENFORCED',
  'CREDIT_UNIT_COST_USD',
  'CREDIT_MARGIN',
  'LLM_PROVIDER',
  'LLM_MODEL',
  'KIE_DEFAULT_MODEL',
] as const;

/** A real (non-trivial) usage vector — the normal case where a creation consumed tokens. */
const usage: TokenUsage = {
  promptTokens: 1000,
  completionTokens: 2000,
  cacheReadTokens: 5000,
  cacheCreationTokens: 0,
};

/** A generation that consumed NOTHING — the instant-failure shape that must always be free. */
const nothing: TokenUsage = { promptTokens: 0, completionTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };

beforeEach(async () => {
  for (const key of SCRUBBED_ENV) {
    vi.stubEnv(key, undefined as unknown as string);
  }

  invalidateMarketPricesCache();

  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'creation-flat-'));
  ledger = new FsLedger(tmp);
  setLedger(ledger);

  /*
   * Same seam as billing.spec.ts: without this stub, settleGeneration deposits real rows into the
   * developer's `.data/generations/` — fixtures that then pollute the §4.10 admin usage report.
   */
  setGenerationStore({ upsert: async () => undefined, list: async () => [] } as unknown as GenerationStore);
});

afterEach(async () => {
  setLedger(undefined);
  setGenerationStore(undefined);
  await fs.rm(tmp, { recursive: true, force: true });
  vi.unstubAllEnvs();
  invalidateMarketPricesCache();
});

/**
 * THE GENERATION PATH NO LONGER FLAT-PRICES — asserted at the SOURCE, and here is why that is the
 * honest form rather than the lazy one.
 *
 * The behavioural assertion we would prefer is "a settlement for a turn carrying
 * `CREATION_BRIEF_MARKER` bills cost-derived". It has no seam: nothing in the suite drives
 * `streamAgent` as far as `settleGeneration` — the proxy specs stop at the prompt (`preload-skills`,
 * `cache-breakpoints`, `skill-selection`) and the billing specs start at `settleGeneration`'s
 * arguments. Standing up a real generation to observe an ARGUMENT THAT IS NOT PASSED would be a large
 * fixture asserting an absence, which is exactly what a source scan does honestly.
 *
 * So this reads the call sites and pins that they carry no pricing overrides. Two failure modes it is
 * built against: a bare `expect(source).not.toContain('minimumCredits')` would be a LIE (the proxy
 * legitimately passes `minimumCredits` to `decidePremium` two statements below the gate), so each scan
 * is scoped to ONE call's arguments; and a scan that silently matches nothing reports all-clear
 * forever, so every scoped extraction is guarded by a CONTROL proving it found the real call.
 */
describe('proxy.ts passes no flat price on the generation path (§4.4a)', () => {
  const proxySource = readFileSync(path.join(process.cwd(), 'app/lib/.server/agent/proxy.ts'), 'utf-8');

  /*
   * Comments are documentation, not behaviour — and here that distinction is load-bearing in BOTH
   * directions: the retirement is documented in prose directly above both call sites (so a
   * post-mortem naming `flatCredits` must not read as the code passing it), and the rename is
   * documented by quoting the OLD name `isCreationTurn` (so the stripped source is the only place the
   * "no stale name" assertion can honestly look).
   */
  const stripped = proxySource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  /** The arguments of one call, brace-matched from `name({` to its closing `}`. */
  function callArgs(name: string): string {
    const source = stripped;
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

  const gate = callArgs('checkCreditGate');
  const settle = callArgs('settleGeneration');

  it('CONTROL — the scan finds both real call sites and their real arguments', () => {
    expect(gate).toContain('userId');
    expect(gate).toContain('byok');
    expect(settle).toContain('generationId');
    expect(settle).toContain('usage');
    expect(settle).toContain('provider');
  });

  /*
   * CONTROL for the scoping itself. `minimumCredits` IS still in proxy.ts — on the `decidePremium`
   * call, which is a different decision entirely. If the extraction ever degenerated to "the whole
   * file", this assertion and the gate assertion below could not both hold.
   */
  it('CONTROL — the scoping is real: minimumCredits still appears elsewhere in the file', () => {
    expect(stripped).toContain('minimumCredits');
    expect(stripped).toContain('decidePremium');
  });

  /* CONTROL — the comment strip works, proven on the one name that survives ONLY in prose. */
  it('CONTROL — comments are stripped, so the rename post-mortem does not count as code', () => {
    expect(proxySource).toContain('isCreationTurn');
    expect(stripped).not.toContain('isCreationTurn');
  });

  it('sets no minimumCredits on the pre-flight gate — no turn cost is knowable up front', () => {
    expect(gate).not.toContain('minimumCredits');
  });

  it('passes neither flatCredits nor maxCredits at settlement — every turn is cost-derived', () => {
    expect(settle).not.toContain('flatCredits');
    expect(settle).not.toContain('maxCredits');
  });

  /*
   * The first-build turn must still EXIST as a concept — it drives ten behaviours (premium lock, skill
   * preload, tool policy, `requiresAction`, discuss suppression, status copy). What changed is that
   * none of them is money. Pinning this stops the retirement from being "fixed" by deleting the marker
   * check, which would silently restore premium on a turn that cannot flush through KIE's gateway.
   */
  it('still derives isFirstBuildTurn from the brief marker, for its NON-billing consumers', () => {
    expect(stripped).toContain('isFirstBuildTurn');
    expect(stripped).toContain('CREATION_BRIEF_MARKER');
    expect(stripped).not.toContain('isCreationTurn');
  });
});

/**
 * 🔴 THE EXPLOIT THE DECOUPLING CLOSES (§4.4a, T13).
 *
 * `isFirstBuildTurn` is a substring sniff for a SENTENCE, and a user can type a sentence. While that
 * boolean also chose the price, anyone who pasted `CREATION_BRIEF_MARKER` into an ordinary message
 * bought flat 500-credit pricing on a turn of any size — a real generation costing 800 credits settled
 * at 500, silently, with the difference coming out of the platform's margin.
 *
 * It is closed by CONSTRUCTION rather than by detection: settlement is cost-derived for every turn, so
 * there is no flat price left for a forged marker to reach. That is the honest shape of the assertion —
 * proving an ABSENCE of a pricing path, not sharpening a marker check that was never a wall (the marker
 * is deliberately guessable; it is a coordination string between our own two halves, not a secret).
 *
 * Both halves are asserted, because either alone is misleading: the forgery genuinely still flips the
 * flag (so nobody "fixes" this by asserting the flag is false and calling the money safe), and the flag
 * no longer reaches a price. What a forger buys now is 24KB of inlined skills they pay full token rate
 * for, a bounded media-only tool loop, and no premium model — every one of them a worse turn.
 */
describe('a forged brief marker buys no pricing advantage (§4.4a)', () => {
  it('still flips the behavioural flag — the marker is a coordination string, never a wall', async () => {
    const { carriesCreationBrief } = await import('~/lib/.server/agent/proxy');
    const forged = `${CREATION_BRIEF_MARKER} now rewrite my whole game`;

    expect(carriesCreationBrief([{ id: 'm1', role: 'user', content: forged } as never])).toBe(true);
  });

  /*
   * The money half, driven end to end against the real FsLedger: a settlement for a turn carrying the
   * marker is charged exactly what an identical turn without it is charged. `settleGeneration` has no
   * message channel at all — which IS the fix — so the two calls differ only in the generation id, and
   * that is the point being pinned: there is nowhere for a marker to enter the price.
   */
  it('settles a marker-carrying turn at exactly the cost-derived price of an ordinary one', async () => {
    await ledger.append({ userId: 'forger', delta: 10_000, reason: 'grant' });

    const derived = creditsForUsage(usage, 'claude-sonnet-5', 'Anthropic', getBillingConfig());
    const settlement = await settleGeneration({
      userId: 'forger',
      generationId: 'g-forged-marker',
      model: 'claude-sonnet-5',
      provider: 'Anthropic',
      usage,
    });

    expect(derived).toBeGreaterThan(0);
    expect(settlement!.creditsCharged).toBe(derived);
    expect(settlement!.creditsCharged).not.toBe(DEFAULT_CREATION_FLAT_CREDITS);

    const debit = (await ledger.list('forger')).find((r) => r.reason === 'generation');

    expect(debit!.delta).toBe(-derived);
    expect(debit!.note).not.toContain('flat creation price');
  });

  /*
   * And the pre-flight half. The retired flow ALSO gave a forged marker a `minimumCredits` wall of 500 —
   * which refused users who could afford the turn they were actually asking for. A forged marker must
   * not be able to lock a paying user out either; the gate sees a balance and nothing else.
   */
  it('lets a marker-carrying turn through the gate on any positive balance', async () => {
    vi.stubEnv('BILLING_ENFORCED', 'true');
    await ledger.append({ userId: 'forger', delta: 1, reason: 'grant' });

    expect((await checkCreditGate({ userId: 'forger' })).allowed).toBe(true);
  });
});

describe('CREATION_FLAT_CREDITS is RETIRED and REFUSED (§4.4a)', () => {
  it('reads 0 — and works — when the variable is unset', () => {
    expect(() => getBillingConfig()).not.toThrow();
    expect(getBillingConfig().creationFlatCredits).toBe(0);
  });

  /*
   * The field survives the retirement (always 0) so the absence is visible where the price used to be
   * read. The old default survives as an exported constant for the same documentary reason — but it
   * must NOT be what the config returns, or the retirement is nominal.
   */
  it('keeps the historical default as a documented constant that prices nothing', () => {
    expect(DEFAULT_CREATION_FLAT_CREDITS).toBe(500);
    expect(getBillingConfig().creationFlatCredits).not.toBe(DEFAULT_CREATION_FLAT_CREDITS);
  });

  it('throws when the variable is set, rather than ignoring it', () => {
    vi.stubEnv('CREATION_FLAT_CREDITS', '500');
    expect(() => getBillingConfig()).toThrow(NotConfiguredError);
  });

  /*
   * 🔴 `0` THROWS TOO, and that is the deliberate answer — the one value where "ignore it" is
   * tempting, because `0` used to mean "flat pricing disabled" and cost-derived billing is exactly
   * what happens now. It still throws for two reasons. (a) The variable no longer has a semantics to
   * agree with: there is no creation turn, so `0` is not a statement about today's system, it is a
   * leftover line about a mechanism that is gone. (b) More concretely, an operator running `=0` was
   * getting FREE creations; under the replacement they are charged `PROJECT_CREATE_CREDITS` (default
   * 150) per New Project. Silently accepting their `0` would let them keep believing creation is free
   * while their users are billed — precisely the mis-bill-waiting-to-be-believed the retired-KIE-price
   * precedent exists to prevent. A one-time boot failure naming the replacement is the cheap half.
   */
  it('throws on 0 as well — the value whose old meaning was "disabled"', () => {
    vi.stubEnv('CREATION_FLAT_CREDITS', '0');
    expect(() => getBillingConfig()).toThrow(NotConfiguredError);
  });

  it('throws on a garbage value — the refusal is about the KEY, never the value', () => {
    vi.stubEnv('CREATION_FLAT_CREDITS', 'abc');
    expect(() => getBillingConfig()).toThrow(NotConfiguredError);
  });

  /*
   * Whitespace-only is treated as unset (`?.trim()`), matching `env()`'s own empty-string-is-undefined
   * rule. Refusing to boot over a blank line an operator left behind is a refusal with no intent
   * behind it — the honest reading of `FOO=` is "not set", not "set to nothing".
   */
  it('treats an empty or whitespace-only value as unset', () => {
    vi.stubEnv('CREATION_FLAT_CREDITS', '   ');
    expect(() => getBillingConfig()).not.toThrow();

    vi.stubEnv('CREATION_FLAT_CREDITS', '');
    expect(() => getBillingConfig()).not.toThrow();
  });

  /*
   * The message is the whole point of failing loudly rather than ignoring: an operator who hits this
   * must not have to read the source to learn what replaced it. Naming BOTH the retired variable and
   * its successor is what turns a boot failure into a migration instruction.
   */
  it('names the replacement variable in the error', () => {
    vi.stubEnv('CREATION_FLAT_CREDITS', '500');

    expect(() => getBillingConfig()).toThrow(/PROJECT_CREATE_CREDITS/);
    expect(() => getBillingConfig()).toThrow(/CREATION_FLAT_CREDITS/);
  });
});

/**
 * RETAINED LEVERS, NO PRODUCTION CALLER. `proxy.ts` stopped passing `flatCredits`/`maxCredits` at the
 * retirement (§4.4a) — every turn settles cost-derived. The parameters stay because they are pure,
 * exported money decisions: not passing them is a pricing choice an operator could reverse, whereas
 * deleting them throws the capability away. What must NEVER regress is that they stay TESTED while
 * uncalled — an untested lever someone re-enables later is worse than no lever at all.
 */
describe('decideCredits (retained flat/cap levers)', () => {
  const base = { model: 'claude-sonnet-5', provider: 'Anthropic' } as const;

  it('charges BYOK zero even when a flat price is set — their key already paid', () => {
    const config = getBillingConfig();

    expect(decideCredits({ ...base, usage, byok: true, flatCredits: 500 }, config)).toBe(0);
  });

  /*
   * Flat pricing charges for a CREATION, not for an instant failure. The auto-refund would usually
   * mask a wrong answer here — "usually" is not a money guarantee.
   */
  it('charges a zero-consumption generation zero even with a flat price set', () => {
    const config = getBillingConfig();

    expect(decideCredits({ ...base, usage: nothing, flatCredits: 500 }, config)).toBe(0);
  });

  it('charges exactly the flat price (floored) when set and tokens were consumed', () => {
    const config = getBillingConfig();

    expect(decideCredits({ ...base, usage, flatCredits: 500 }, config)).toBe(500);
    expect(decideCredits({ ...base, usage, flatCredits: 250.7 }, config)).toBe(250);
  });

  it('falls back to the cost-derived formula when no flat price is set (or it is 0)', () => {
    const config = getBillingConfig();
    const derived = creditsForUsage(usage, base.model, base.provider, config);

    expect(decideCredits({ ...base, usage }, config)).toBe(derived);
    expect(decideCredits({ ...base, usage, flatCredits: 0 }, config)).toBe(derived);
  });

  /* The STOP shape (§4.12): bill what was consumed, bounded by the advertised ceiling. */
  it('caps a cost-derived charge at maxCredits when maxCredits is set and binding', () => {
    const config = getBillingConfig();
    const big: TokenUsage = {
      promptTokens: 100_000,
      completionTokens: 50_000,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    };
    const derived = creditsForUsage(big, base.model, base.provider, config);

    expect(derived).toBeGreaterThan(5);
    expect(decideCredits({ ...base, usage: big, maxCredits: 5 }, config)).toBe(5);
  });

  it('leaves a cost-derived charge alone when maxCredits is not binding (or unset/0)', () => {
    const config = getBillingConfig();
    const derived = creditsForUsage(usage, base.model, base.provider, config);

    expect(decideCredits({ ...base, usage, maxCredits: derived + 1_000 }, config)).toBe(derived);
    expect(decideCredits({ ...base, usage, maxCredits: 0 }, config)).toBe(derived);
  });

  /* Mutually exclusive at the call site by construction; if both arrive, the flat price WINS. */
  it('lets the flat price win when both flatCredits and maxCredits are set', () => {
    const config = getBillingConfig();

    expect(decideCredits({ ...base, usage, flatCredits: 500, maxCredits: 5 }, config)).toBe(500);
  });
});

/**
 * The gate's `minimumCredits` wall — likewise retained and likewise uncalled since the retirement
 * (`proxy.ts` sets no minimum: no turn's cost is knowable pre-flight any more, and the flat charge
 * moved ahead of the generation entirely). ⚠️ Its refusal message still reads "Creating a new project
 * costs N credits", which describes the charge that `decideProjectCreateCharge` now owns — if this
 * lever is ever re-enabled for something else, the copy has to move with it.
 */
describe('credit gate with minimumCredits (retained, currently uncalled)', () => {
  it('refuses when enforced and the balance is below the minimum, naming both numbers', async () => {
    vi.stubEnv('BILLING_ENFORCED', 'true');
    await ledger.append({ userId: 'u1', delta: 100, reason: 'grant' });

    const result = await checkCreditGate({ userId: 'u1', minimumCredits: 500 });

    expect(result.allowed).toBe(false);

    if (!result.allowed) {
      expect(result.message).toContain('500');
      expect(result.message).toContain('100');
    }
  });

  it('allows a balance exactly at the minimum', async () => {
    vi.stubEnv('BILLING_ENFORCED', 'true');
    await ledger.append({ userId: 'u1', delta: 500, reason: 'grant' });

    expect((await checkCreditGate({ userId: 'u1', minimumCredits: 500 })).allowed).toBe(true);
  });

  it('allows a balance above the minimum', async () => {
    vi.stubEnv('BILLING_ENFORCED', 'true');
    await ledger.append({ userId: 'u1', delta: 501, reason: 'grant' });

    expect((await checkCreditGate({ userId: 'u1', minimumCredits: 500 })).allowed).toBe(true);
  });

  it('ignores an unset or zero minimum — any positive balance passes (the ordinary-turn contract)', async () => {
    vi.stubEnv('BILLING_ENFORCED', 'true');
    await ledger.append({ userId: 'u1', delta: 1, reason: 'grant' });

    expect((await checkCreditGate({ userId: 'u1' })).allowed).toBe(true);
    expect((await checkCreditGate({ userId: 'u1', minimumCredits: 0 })).allowed).toBe(true);
  });

  /*
   * The zero-balance refusal comes FIRST and keeps its own (generic) message — a user with nothing
   * gets "out of credits", not creation-specific arithmetic about a turn they cannot start anyway.
   */
  it('keeps the zero-balance refusal ahead of the minimum check', async () => {
    vi.stubEnv('BILLING_ENFORCED', 'true');

    const result = await checkCreditGate({ userId: 'broke', minimumCredits: 500 });

    expect(result.allowed).toBe(false);

    if (!result.allowed) {
      expect(result.message).toContain('out of credits');
      expect(result.message).not.toContain('500');
    }
  });

  it('never blocks when billing is not enforced, regardless of the minimum', async () => {
    vi.stubEnv('BILLING_ENFORCED', 'false');

    const result = await checkCreditGate({ userId: 'broke', minimumCredits: 500 });

    expect(result.allowed).toBe(true);
    expect(result.mode).toBe('unmetered');
  });

  it('lets BYOK through regardless of balance and minimum — their key pays', async () => {
    vi.stubEnv('BILLING_ENFORCED', 'true');

    const result = await checkCreditGate({ userId: 'pro', byok: true, minimumCredits: 500 });

    expect(result.allowed).toBe(true);
    expect(result.mode).toBe('byok');
  });
});

describe('settlement with a flat price (retained lever, driven against the real FsLedger)', () => {
  it('debits exactly the flat price, records the TRUE raw cost, and names the pricing model in the note', async () => {
    await ledger.append({ userId: 'u1', delta: 10_000, reason: 'grant' });

    const settlement = await settleGeneration({
      userId: 'u1',
      generationId: 'g-flat',
      model: 'claude-sonnet-5',
      provider: 'Anthropic',
      usage,
      flatCredits: 500,
    });

    expect(settlement!.creditsCharged).toBe(500);
    expect(settlement!.balanceAfter).toBe(9_500);
    expect(await ledger.balance('u1')).toBe(9_500);

    // rawCostUsd stays the token-derived truth — the Admin report watches realized margin with it.
    expect(settlement!.rawCostUsd).toBeCloseTo(rawCostUsd(usage, 'claude-sonnet-5', 'Anthropic'), 10);

    const debit = (await ledger.list('u1')).find((r) => r.reason === 'generation');

    expect(debit!.delta).toBe(-500);
    expect(debit!.note).toContain('flat creation price');
  });

  it('does NOT mark an ordinary cost-derived debit as flat-priced', async () => {
    await ledger.append({ userId: 'u1', delta: 10_000, reason: 'grant' });

    await settleGeneration({
      userId: 'u1',
      generationId: 'g-ordinary',
      model: 'claude-sonnet-5',
      provider: 'Anthropic',
      usage,
    });

    const debit = (await ledger.list('u1')).find((r) => r.reason === 'generation');

    expect(debit!.note).not.toContain('flat creation price');
  });

  /* The stopped-creation shape: min(consumed, advertised flat ceiling). */
  it('caps a cost-derived charge at maxCredits', async () => {
    await ledger.append({ userId: 'u1', delta: 10_000, reason: 'grant' });

    const big: TokenUsage = {
      promptTokens: 100_000,
      completionTokens: 50_000,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    };
    const settlement = await settleGeneration({
      userId: 'u1',
      generationId: 'g-capped',
      model: 'claude-sonnet-5',
      provider: 'Anthropic',
      usage: big,
      maxCredits: 5,
    });

    expect(settlement!.creditsCharged).toBe(5);
    expect(await ledger.balance('u1')).toBe(9_995);
  });

  it('charges nothing for a zero-usage generation even with the flat price set', async () => {
    await ledger.append({ userId: 'u1', delta: 10_000, reason: 'grant' });

    const settlement = await settleGeneration({
      userId: 'u1',
      generationId: 'g-nothing',
      model: 'claude-sonnet-5',
      provider: 'Anthropic',
      usage: nothing,
      flatCredits: 500,
    });

    expect(settlement!.creditsCharged).toBe(0);
    expect(await ledger.balance('u1')).toBe(10_000);

    // No debit row at all — a free generation leaves only the grant in the ledger.
    expect((await ledger.list('u1')).filter((r) => r.reason === 'generation')).toHaveLength(0);
  });
});
