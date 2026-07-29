/**
 * The flat New Project charge — a PURE money decision (SPEC §4.4a, §4.6, `spec/billing.md`).
 *
 * Under the project-first creation flow (2026-07-29) a New Project runs no generation: it clones the
 * pinned starter template, installs it and serves it. The owner's rule for that path is *"nothing else
 * should be able to stop the project from getting created"* — and this function is the ONE permitted
 * exception, which is why it is pure, exported and exhaustively tested rather than inlined in a route.
 *
 * The exception is legitimate only because of WHERE it runs: the decision is made BEFORE anything is
 * provisioned — no project row, no VM, no template fetch — so a refusal leaves nothing half-made. That is
 * categorically different from a mid-creation failure, which is what the owner's rule is actually about.
 * It is also why `project_create` is absent from `mayGoNegative` (migration 0015): a debit taken before
 * the spend it pays for must refuse, never overdraw.
 *
 * ## The four states, stated (`spec/fail-loud.md` §"When you add a paid path")
 *
 * - **Refused** — enforced billing, no BYOK, balance below the price. 402 naming the price AND the
 *   balance; no project row, no ledger row.
 * - **Charged** — one `project_create` debit, then the project is registered.
 * - **Free** — `credits === 0` (operator disabled it), BYOK, or unmetered mode. No ledger row is written
 *   at all: a zero-value entry is noise in an audit trail, not evidence.
 * - **Refunded** — the project is deleted having never completed a generation (see the DELETE path); the
 *   refund reuses reason `'refund'`.
 */

export interface ProjectCreateChargeInput {
  /** The configured flat price (`BillingConfig.projectCreateCredits`). `0` means creation is free. */
  credits: number;

  /** The user's derived balance. */
  balance: number;

  /** `BILLING_ENFORCED` — unmetered mode records nothing and refuses nothing. */
  enforced: boolean;

  /** Server-VERIFIED Pro entitlement. Their key pays for the build; creation rides along free. */
  byok?: boolean;
}

export interface ProjectCreateChargeDecision {
  /** Credits to debit. `0` means write NO ledger row — not a zero-value one. */
  charge: number;

  /** Refuse the creation outright (402). Mutually exclusive with a non-zero `charge`. */
  refuse: boolean;

  /** Why it was refused, naming the price and the balance. Present only when `refuse`. */
  message?: string;

  /** Why it is free, for the log line. Present only when `charge === 0 && !refuse`. */
  freeReason?: 'disabled' | 'byok' | 'unmetered';
}

/**
 * Decide what creating a project costs this user, right now.
 *
 * Ordered so the cheapest, least surprising outcome wins: a disabled price frees everyone (including
 * users with no balance at all), and BYOK/unmetered never refuse.
 */
export function decideProjectCreateCharge(input: ProjectCreateChargeInput): ProjectCreateChargeDecision {
  const price = Number.isFinite(input.credits) && input.credits > 0 ? Math.floor(input.credits) : 0;

  if (price === 0) {
    return { charge: 0, refuse: false, freeReason: 'disabled' };
  }

  if (input.byok) {
    return { charge: 0, refuse: false, freeReason: 'byok' };
  }

  if (!input.enforced) {
    return { charge: 0, refuse: false, freeReason: 'unmetered' };
  }

  if (input.balance < price) {
    return {
      charge: 0,
      refuse: true,

      /*
       * NAME both numbers. "Insufficient credits" tells the user nothing they can act on; the price and
       * their balance together tell them exactly how many to buy (the `gate.ts` minimum-credits copy is
       * the house model for this).
       */
      message: `Creating a new project costs ${price} credits and you have ${input.balance}. Add credits to start one.`,
    };
  }

  return { charge: price, refuse: false };
}
