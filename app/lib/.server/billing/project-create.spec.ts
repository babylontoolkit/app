/**
 * The flat New Project charge — config (`PROJECT_CREATE_CREDITS`) + the pure decision
 * (`decideProjectCreateCharge`). Both halves are money paths that fail SILENTLY.
 *
 * Why each property here is worth a test:
 *
 * - **This is the ONE thing allowed to stop a project being created** (§4.4a: *"nothing else should be
 *   able to stop the project from getting created"*). A wrong `refuse` is either a user who cannot
 *   start a project they can afford, or a deep-negative balance on a debit taken before any spend —
 *   which is exactly why `project_create` is absent from `mayGoNegative` (asserted in `billing.spec.ts`).
 * - **`charge === 0` must never be a refusal and never a ledger row.** A zero-value entry is noise in an
 *   audit trail, not evidence; and a `0` price is the operator's real "creation is free" switch, so it
 *   must free EVERYONE — including a user with a zero (or negative) balance, who under any other reading
 *   would be refused a free action.
 * - **The refusal must NAME the price and the balance.** "Insufficient credits" is unactionable; the two
 *   numbers together tell the user exactly how many to buy (`gate.ts`'s minimum-credits copy is the
 *   house model). A message that silently loses a number still passes a `refuse === true` assertion.
 * - **A negative override must be IGNORED, never obeyed.** Obeying one turns New Project into a credit
 *   faucet: click it in a loop, get paid. Nothing throws.
 * - **`.env.example` must define the var exactly once.** This file has a documented history of a var
 *   (`SIGNUP_GRANT_CREDITS`) defined twice with DIFFERENT values, where the later line wins in a real
 *   `.env` — so copying the file silently handed out the wrong number. A prose warning cannot fail; the
 *   scan below can.
 *
 * ⚠️ The `oauth.spec.ts` trap: `env()` falls back to `process.env` and vitest loads `.env.local`, so an
 * "unset" assertion grades the developer's own configuration unless the WHOLE precedence chain is
 * scrubbed first (`.env.example` actively tells operators to set `PROJECT_CREATE_CREDITS`). Mirrors the
 * `SCRUBBED_ENV` posture of `creation-flat.spec.ts`, its sibling.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PROJECT_CREATE_CREDITS, getBillingConfig } from './rates';
import { decideProjectCreateCharge, type ProjectCreateChargeInput } from './project-create';
import { ENV_EXAMPLE_FILENAME, envExampleAssignments } from './env-example';

/**
 * The full chain that can reach `getBillingConfig().projectCreateCredits`. `BILLING_ENFORCED` rides
 * along because the decision's free/refuse branches key off it and a developer's `.env.local` sets it.
 */
const SCRUBBED_ENV = [
  'PROJECT_CREATE_CREDITS',
  'BILLING_ENFORCED',

  /*
   * Its RETIRED PREDECESSOR belongs in the same list (§4.4a): `getBillingConfig` refuses
   * `CREATION_FLAT_CREDITS` outright, so an operator who has not yet migrated to the variable this
   * file is about cannot run a single assertion in it.
   */
  'CREATION_FLAT_CREDITS',
] as const;

beforeEach(() => {
  for (const key of SCRUBBED_ENV) {
    vi.stubEnv(key, undefined as unknown as string);
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('projectCreateCredits config (PROJECT_CREATE_CREDITS)', () => {
  it('defaults to 100 — the owner-decided price of standing a project up (2026-07-30)', () => {
    expect(DEFAULT_PROJECT_CREATE_CREDITS).toBe(100);

    // Named literally as well as by constant, so moving the default has to walk past this line.
    expect(getBillingConfig().projectCreateCredits).toBe(100);
  });

  /* `0` is a REAL value, not "unset": the operator switch that makes project creation free. */
  it('accepts 0 as "project creation is free"', () => {
    vi.stubEnv('PROJECT_CREATE_CREDITS', '0');
    expect(getBillingConfig().projectCreateCredits).toBe(0);
  });

  it('honors a positive override', () => {
    vi.stubEnv('PROJECT_CREATE_CREDITS', '200');
    expect(getBillingConfig().projectCreateCredits).toBe(200);
  });

  /* Obeying a negative would CREDIT a user for clicking New Project — ignore, never obey. */
  it('ignores a negative override in favor of the default', () => {
    vi.stubEnv('PROJECT_CREATE_CREDITS', '-50');
    expect(getBillingConfig().projectCreateCredits).toBe(DEFAULT_PROJECT_CREATE_CREDITS);
  });

  it('ignores a non-numeric (non-finite) override in favor of the default', () => {
    vi.stubEnv('PROJECT_CREATE_CREDITS', 'abc');
    expect(getBillingConfig().projectCreateCredits).toBe(DEFAULT_PROJECT_CREATE_CREDITS);

    vi.stubEnv('PROJECT_CREATE_CREDITS', 'Infinity');
    expect(getBillingConfig().projectCreateCredits).toBe(DEFAULT_PROJECT_CREATE_CREDITS);
  });

  it('floors a fractional override — credits are integers', () => {
    vi.stubEnv('PROJECT_CREATE_CREDITS', '150.9');
    expect(getBillingConfig().projectCreateCredits).toBe(150);
  });

  /*
   * A per-request context beats ambient env (`env()` reads `context.cloudflare.env` FIRST). The nesting
   * is load-bearing: a flat `{ PROJECT_CREATE_CREDITS }` object is silently ignored and the test would
   * grade the default while looking like it graded the override.
   */
  it('reads the value from a request context when one is supplied', () => {
    expect(getBillingConfig({ cloudflare: { env: { PROJECT_CREATE_CREDITS: '120' } } }).projectCreateCredits).toBe(120);
  });
});

describe('decideProjectCreateCharge', () => {
  /** Enforced billing, no BYOK, plenty of balance: the ordinary paying case. */
  const paying: ProjectCreateChargeInput = { credits: 150, balance: 1_000, enforced: true };

  it('charges exactly the configured price when the balance covers it', () => {
    expect(decideProjectCreateCharge(paying)).toEqual({ charge: 150, refuse: false });
  });

  it('allows a balance EXACTLY at the price — the boundary is inclusive', () => {
    expect(decideProjectCreateCharge({ ...paying, balance: 150 })).toEqual({ charge: 150, refuse: false });
  });

  it('floors a fractional price — a debit is an integer number of credits', () => {
    expect(decideProjectCreateCharge({ ...paying, credits: 150.9 }).charge).toBe(150);
  });

  describe('free (charge 0, refuse false — and therefore NO ledger row)', () => {
    /*
     * `credits === 0` is the operator's "creation is free" switch, so it has to win BEFORE the balance
     * check: a user with nothing (or a negative balance from a generation that was allowed to overdraw)
     * must still be able to create a project. Charge 0 is also the signal to write no ledger entry at
     * all — a zero-value row is noise in an audit trail, not evidence.
     */
    it('never refuses and never charges when the price is 0, at ANY balance', () => {
      for (const balance of [0, -900, 5, 10_000]) {
        expect(decideProjectCreateCharge({ credits: 0, balance, enforced: true })).toEqual({
          charge: 0,
          refuse: false,
          freeReason: 'disabled',
        });
      }
    });

    /* A negative/garbage price cannot slip past the config validator via a direct call either. */
    it('treats a negative or non-finite price as disabled rather than crediting the user', () => {
      for (const credits of [-150, Number.NaN, Number.POSITIVE_INFINITY]) {
        const decision = decideProjectCreateCharge({ credits, balance: 0, enforced: true });

        expect(decision.charge).toBe(0);
        expect(decision.refuse).toBe(false);

        // Never a NEGATIVE charge: that would be a credit grant wearing a debit's clothes.
        expect(decision.charge).toBeGreaterThanOrEqual(0);
      }
    });

    /* Their key pays for the build; the platform does not gate creation on our credit balance. */
    it('is free for BYOK regardless of balance', () => {
      expect(decideProjectCreateCharge({ credits: 150, balance: 0, enforced: true, byok: true })).toEqual({
        charge: 0,
        refuse: false,
        freeReason: 'byok',
      });
    });

    /* Unmetered mode records nothing and refuses nothing (the local-dev / trusted-deploy posture). */
    it('is free when billing is not enforced, even with a zero balance', () => {
      expect(decideProjectCreateCharge({ credits: 150, balance: 0, enforced: false })).toEqual({
        charge: 0,
        refuse: false,
        freeReason: 'unmetered',
      });
    });

    it('prefers BYOK over unmetered when both apply — the reason is a log line, not a branch', () => {
      expect(decideProjectCreateCharge({ credits: 150, balance: 0, enforced: false, byok: true }).freeReason).toBe(
        'byok',
      );
    });
  });

  describe('refusal', () => {
    it('refuses when enforced and the balance is below the price', () => {
      const decision = decideProjectCreateCharge({ credits: 150, balance: 149, enforced: true });

      expect(decision.refuse).toBe(true);

      // Mutually exclusive with a charge: a refused creation must never also debit.
      expect(decision.charge).toBe(0);
      expect(decision.freeReason).toBeUndefined();
    });

    /*
     * NAMING BOTH NUMBERS IS THE POINT. `refuse === true` passes with any message; only these
     * assertions catch a copy edit that drops the arithmetic the user needs to act on.
     */
    it('names BOTH the price and the balance in the refusal message', () => {
      const decision = decideProjectCreateCharge({ credits: 150, balance: 20, enforced: true });

      expect(decision.message).toContain('150');
      expect(decision.message).toContain('20');
    });

    it('names the FLOORED price, not the raw configured value', () => {
      // A message quoting "150.9 credits" would ask for a price the ledger cannot debit.
      const decision = decideProjectCreateCharge({ credits: 150.9, balance: 20, enforced: true });

      expect(decision.message).toContain('150');
      expect(decision.message).not.toContain('150.9');
    });

    it('refuses a zero or negative balance under enforced billing with a non-zero price', () => {
      expect(decideProjectCreateCharge({ credits: 150, balance: 0, enforced: true }).refuse).toBe(true);
      expect(decideProjectCreateCharge({ credits: 150, balance: -50, enforced: true }).refuse).toBe(true);
    });

    /* The three ways NOT to refuse, restated as a wall: only enforced + no BYOK + short balance refuses. */
    it('never refuses unless billing is enforced and BYOK is absent', () => {
      const short = { credits: 150, balance: 1 };

      expect(decideProjectCreateCharge({ ...short, enforced: false }).refuse).toBe(false);
      expect(decideProjectCreateCharge({ ...short, enforced: true, byok: true }).refuse).toBe(false);
      expect(decideProjectCreateCharge({ ...short, enforced: false, byok: true }).refuse).toBe(false);
      expect(decideProjectCreateCharge({ ...short, enforced: true }).refuse).toBe(true);
    });
  });

  /* A decision that both charges and refuses would double-punish; assert the invariant directly. */
  it('never returns a non-zero charge together with a refusal, across the whole input space', () => {
    for (const credits of [0, 150, -1]) {
      for (const balance of [-10, 0, 149, 150, 10_000]) {
        for (const enforced of [true, false]) {
          for (const byok of [true, false]) {
            const decision = decideProjectCreateCharge({ credits, balance, enforced, byok });

            expect(decision.refuse ? decision.charge === 0 : true).toBe(true);
            expect(decision.charge).toBeGreaterThanOrEqual(0);

            // A message exists exactly when it is a refusal, and a freeReason exactly when it is free.
            expect(Boolean(decision.message)).toBe(decision.refuse);
            expect(Boolean(decision.freeReason)).toBe(!decision.refuse && decision.charge === 0);
          }
        }
      }
    }
  });
});

/**
 * `.env.example` is copied to make a real `.env`, where a LATER line silently wins. `SIGNUP_GRANT_CREDITS`
 * was once assigned twice with different values in this very file and handed out the wrong grant to
 * anyone who copied it — the file now carries a prose warning about that, and a prose warning cannot
 * fail. This is the mechanism that replaced it, for this variable.
 *
 * The counting itself lives in `env-example.ts` so that this pin and the §4.6.1a model-tier-ladder pin
 * (`model-tiers.spec.ts`) share ONE definition of "assigns this key" — two counters that disagree fail
 * in the safe-looking direction, reporting no duplicates forever.
 */
describe('.env.example documents PROJECT_CREATE_CREDITS exactly once', () => {
  const example = readFileSync(path.join(process.cwd(), ENV_EXAMPLE_FILENAME), 'utf8');
  const assignments = envExampleAssignments(example, 'PROJECT_CREATE_CREDITS');

  it('assigns it on exactly one line (commented-out duplicates count — they get uncommented)', () => {
    expect(assignments).toHaveLength(1);
  });

  it('assigns the documented default, so a copied file bills what the code bills', () => {
    expect(assignments[0].trim()).toBe(`PROJECT_CREATE_CREDITS=${DEFAULT_PROJECT_CREATE_CREDITS}`);
  });

  it('documents the default and the 0-disables semantics in the surrounding comment', () => {
    const index = example.indexOf('PROJECT_CREATE_CREDITS=');
    const commentBlock = example.slice(Math.max(0, index - 1_200), index);

    // "0 disables" is the operator escape hatch; undocumented, it reads as "unset" and never gets used.
    expect(commentBlock).toMatch(/0 disables/i);
    expect(commentBlock).toContain(String(DEFAULT_PROJECT_CREATE_CREDITS));

    // The ignore-a-bad-override posture is a promise to operators; say it where they will read it.
    expect(commentBlock).toMatch(/ignored/i);
  });
});
