/**
 * The vocabulary of what we observe (SPEC §5A).
 *
 * Kept in its own module — with NO server-only imports — so the client error-capture route and any
 * future client emitter can share the exact event names the server records. A funnel that names its
 * stages differently on the two sides is a funnel that cannot be joined.
 */

/**
 * The acquisition funnel (§5A). These are the stages management charts to tell the growth story:
 * signup → verified → first generation → first playable → share → purchase, plus the retention
 * signals in between. The NAMES are the contract with whatever analytics sink is wired in later —
 * changing one renames a column in someone's dashboard, so treat them as stable identifiers.
 */
export const FUNNEL_EVENTS = {
  SIGNUP: 'signup',
  VERIFIED: 'verified',
  PROJECT_CREATED: 'project_created',
  GENERATION_STARTED: 'generation_started',
  GENERATION_COMPLETED: 'generation_completed',
  GENERATION_FAILED: 'generation_failed',
  FIRST_PLAYABLE: 'first_playable',
  SHARE_PUBLISHED: 'share_published',
  REMIX_CREATED: 'remix_created',
  PURCHASE_COMPLETED: 'purchase_completed',

  /**
   * The funnel's exit (§4.5.1). Churn is a growth number like any other, and this is the only place
   * it can be counted: the ledger keeps the user's spend after deletion (migration 0017) but nothing
   * in it records that they LEFT, and the account row that would have said so is gone.
   */
  ACCOUNT_DELETED: 'account_deleted',
} as const;

export type FunnelEvent = (typeof FUNNEL_EVENTS)[keyof typeof FUNNEL_EVENTS];

/**
 * Operational alert signals (§5A). These are the "wake someone up" conditions — distinct from funnel
 * events, which are just history. Each maps to a threshold or a failure the operator needs to know
 * about before a user reports it: a spike in failed generations, a webhook we could not verify, a
 * doc/skill sync that could not build.
 */
export const ALERT_SIGNALS = {
  GENERATION_FAILURE_RATE: 'generation_failure_rate',
  GENERATION_FAILED: 'generation_failed',
  WEBHOOK_FAILURE: 'webhook_failure',
  DOCSYNC_BUILD_FAILURE: 'docsync_build_failure',
  SKILLSSYNC_BUILD_FAILURE: 'skillssync_build_failure',

  /*
   * A money-path write we could not complete and are not allowed to fail the request over
   * (`spec/fail-loud.md` rule 4): a debit's foreign-key anchor that did not land, a charge or refund
   * the ledger refused, a paid render whose task record could not be stored.
   *
   * Every one of these used to be `catch` + `logger.error`, which is invisible in production — and
   * each is a case where money moved and the books did not follow it. They cannot throw (settlement
   * runs in a `finally`, refunds compensate an already-failed request), so ALERTING is the only
   * loudness available to them.
   */
  LEDGER_INTEGRITY: 'ledger_integrity',

  /*
   * An automatic rescue on the paid path is firing at a RATE (`spec/fail-loud.md` Stage C).
   *
   * The rescues work — that is the problem. A `+unproductive-rescue` or `+forced-continuation` that
   * fires occasionally has done its job and cost the user nothing extra; one that fires on a quarter
   * of generations means **the cause is upstream of the rescue and the rescue is only paying for
   * it**. Recording a marker nobody watches is rule 9 waiting to fire, so this is the watching.
   */
  RESCUE_MARKER_RATE: 'rescue_marker_rate',

  /**
   * Refunds are the operator eating a cost the provider already billed us for. One is ordinary; a
   * sustained fraction of a ledger reason's work ending in a refund is a broken subsystem.
   */
  REFUND_RATE: 'refund_rate',

  /**
   * A rising fraction of sandbox creates or resumes is failing (`sandbox-rates.ts`).
   *
   * This is "users cannot open their projects" — the sandbox is where their game lives, so a sustained
   * failure rate here is a product outage even while generation, billing and auth are all perfectly
   * healthy. It is a RATE and not a per-failure alert because a single provider hiccup is ordinary and
   * the route already retries around the ones it can classify.
   */
  SANDBOX_FAILURE_RATE: 'sandbox_failure_rate',

  /**
   * A rising fraction of resumes is coming back `CLEAN` (`sandbox-rates.ts`).
   *
   * Deliberately NOT folded into the failure rate: every one of these requests SUCCEEDED. But `CLEAN`
   * means the hibernation snapshot had expired and the VM came up as template state, so the project's
   * files came from the working copy rather than from the machine — the closest thing this subsystem
   * has to a data-loss signal, and one that no failure metric can ever show.
   */
  SANDBOX_CLEAN_BOOT_RATE: 'sandbox_clean_boot_rate',

  /**
   * The request we ASSEMBLED does not satisfy something we believe about every request
   * (`agent/request-invariants.ts`, SPEC §4.2 step 2a).
   *
   * A duplicate file listed twice, a file body that survived compaction, a first build turn whose
   * manifest is missing the framework, a model handoff that never reached the record. Every one of
   * those has happened, none of them threw, and in each case the token count moved in a direction
   * that reads as ordinary — which is §4.2.8's stated failure mode: *a regression here throws no
   * error and fails no build; it silently multiplies the input bill.*
   *
   * ⚠️ It is a RATE, on its OWN rolling window (`REQUEST_INTEGRITY_RATE_CONFIG` — the shared default's
   * 50%-of-20 threshold measurably silenced it). A per-turn alert on a systemic mismatch is a pager
   * that gets muted inside a day, and a muted pager is the same as no guard.
   */
  REQUEST_INTEGRITY: 'request_integrity',
} as const;

export type AlertSignal = (typeof ALERT_SIGNALS)[keyof typeof ALERT_SIGNALS];

export type AlertSeverity = 'info' | 'warning' | 'critical';
