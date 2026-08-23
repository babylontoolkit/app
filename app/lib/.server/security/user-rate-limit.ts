/**
 * Per-USER rate limiting for outbound spend paths (SPEC §5, §10 item 20).
 *
 * ## Why the inherited limiter was not enough
 *
 * `app/lib/security.ts`'s `checkRateLimit` is keyed `${clientIP}:${endpoint}`. For an *anonymous*
 * plumbing route that is the only key available and it is the right one. For a route that is already
 * behind two walls it is the WRONG key twice over: it punishes everyone behind one NAT or corporate
 * proxy as though they were one caller, and it is reset by any account holder who changes IP — which
 * is exactly the person a limit on a verified route is meant to bound. `spec/spend-holes.md`'s rule is
 * that "verified" is not "unmetered", and an IP is not a user.
 *
 * So this keys on the authenticated user id, which the caller already has because the wall ran first.
 *
 * ## What it is honest about NOT being
 *
 * 🔴 **The default store is IN-PROCESS, so a multi-instance deployment gets N times the limit.** That
 * is a real weakening and it is stated rather than hidden: this closes the "change your IP and start
 * again" hole, which is the one an individual can exploit at will, and leaves the horizontal-scaling
 * hole, which requires the operator to have scaled out. A shared store (Redis, or a Postgres table)
 * is the completion, and `setUserRateLimitStore` is the seam it plugs into — deliberately the same
 * shape as `setGitTokenStore`/`setProjectStore` so the swap is a wiring change, not a rewrite.
 *
 * Do not "fix" the gap by deleting this and going back to the IP limiter: per-instance-per-user is
 * strictly tighter than per-instance-per-IP, and the seam is what makes the real fix cheap.
 *
 * ## The shape
 *
 * A fixed window, not a token bucket. A window is coarser, but it is one integer and one timestamp per
 * key, it cannot drift, and the failure mode of the coarse edge (twice the limit across a boundary) is
 * bounded and understood — where a bucket implemented slightly wrong leaks quietly, which is the
 * failure this file exists to avoid.
 */
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('security.user-rate-limit');

export interface UserRateLimitDecision {
  allowed: boolean;

  /** How many are left in the current window (0 when refused). */
  remaining: number;

  /** When the window resets, epoch ms — surfaced as `Retry-After` so a client can behave. */
  resetAt: number;
}

export interface UserRateLimitRule {
  /** Window length in ms. */
  windowMs: number;

  /** How many calls one user may make inside a window. */
  max: number;
}

export interface UserRateLimitStore {
  /**
   * Count this call and report the decision. MUST be atomic per key — a read-then-write from two
   * concurrent requests is how a limiter silently permits double its limit under exactly the load it
   * exists to bound (the `append_ledger_entry` lesson, one subsystem over).
   */
  hit(key: string, rule: UserRateLimitRule, now: number): Promise<UserRateLimitDecision>;
}

/** The in-process default. Single-instance-correct; see the header for what it does not cover. */
export class MemoryUserRateLimitStore implements UserRateLimitStore {
  private readonly _windows = new Map<string, { count: number; resetAt: number }>();

  async hit(key: string, rule: UserRateLimitRule, now: number): Promise<UserRateLimitDecision> {
    const existing = this._windows.get(key);

    if (!existing || existing.resetAt <= now) {
      const resetAt = now + rule.windowMs;
      this._windows.set(key, { count: 1, resetAt });

      /*
       * Opportunistic sweep of expired keys. Without it the map is an unbounded leak keyed by user id
       * — slow, invisible, and worst on the busiest instance. Bounded work: only on a window roll.
       */
      if (this._windows.size > 1_000) {
        for (const [k, v] of this._windows) {
          if (v.resetAt <= now) {
            this._windows.delete(k);
          }
        }
      }

      return { allowed: true, remaining: rule.max - 1, resetAt };
    }

    if (existing.count >= rule.max) {
      return { allowed: false, remaining: 0, resetAt: existing.resetAt };
    }

    existing.count += 1;

    return { allowed: true, remaining: rule.max - existing.count, resetAt: existing.resetAt };
  }
}

let store: UserRateLimitStore | undefined;

/** Swap the backing store (tests, or a shared Redis/Postgres implementation). */
export function setUserRateLimitStore(next: UserRateLimitStore | undefined): void {
  store = next;
}

export function getUserRateLimitStore(): UserRateLimitStore {
  if (!store) {
    store = new MemoryUserRateLimitStore();
  }

  return store;
}

/**
 * Repository IMPORT — the tightest rule in the product, because it is the most expensive per call.
 *
 * One clone can pull up to `GIT_CLONE_MAX_MB` (256MB default) of somebody else's repository through
 * our egress. Ten an hour is far above any honest use — a person imports a project, not a catalogue —
 * and far below what would cost real money.
 */
export const CLONE_RATE_LIMIT: UserRateLimitRule = { windowMs: 60 * 60 * 1000, max: 10 };

/**
 * Branch CREATE and DELETE — writes against the user's own repository (SPEC §4.13).
 *
 * Looser than a clone because the cost is a single small API call rather than a whole repository
 * through our egress, and tighter than nothing because these are WRITES landing in somebody's account
 * with their name on them: a runaway client that created a branch per keystroke would fill a real
 * person's repository with rubbish they then have to clean up by hand.
 *
 * Create and delete deliberately SHARE one bucket. They are the same class of action from the
 * provider's point of view, and splitting them lets a loop alternate between the two and spend twice
 * the budget — the same reason a rate limit is keyed on the user rather than on the endpoint.
 */
export const BRANCH_WRITE_RATE_LIMIT: UserRateLimitRule = { windowMs: 60 * 60 * 1000, max: 60 };

/**
 * Reading a whole branch's tree — the Review-changes and Switch reads.
 *
 * ⚠️ **THREE TIMES the clone allowance, and that is deliberate — do not read it as "safer than a
 * clone".** Each call is bounded by the same `GIT_CLONE_MAX_MB` ceiling, so the worst-case egress on
 * this bucket is genuinely LARGER than on the import bucket. (An earlier version of this comment
 * claimed it was "well below the clone budget", which contradicted its own previous sentence and the
 * number underneath it — a false claim about a safety property, the class this repo keeps finding.)
 *
 * What actually justifies the higher number is not size, it is REACH. An import names an arbitrary
 * URL, so its budget is a limit on pulling other people's repositories through our egress. A tree read
 * runs after the linked-repo gate and can only ever read the project's OWN repository — the same
 * bytes, over and over — so a runaway client here re-reads one known repo rather than harvesting a
 * catalogue. Against that, an interactive action (look at a branch, change your mind, look at another)
 * needs more headroom than a once-per-project import.
 */
export const TREE_READ_RATE_LIMIT: UserRateLimitRule = { windowMs: 60 * 60 * 1000, max: 30 };

/**
 * A refusal a caller can act on: 429 + `Retry-After`, and a sentence naming the wait.
 *
 * `subject` names what was throttled, and it defaults to the clone limit this class was written for so
 * every existing call site keeps its exact wording. It is a parameter because the message is SHOWN —
 * `RateLimitedError` is in `SAFE_ERRORS`, so a second caller reusing this class would otherwise tell a
 * Unity developer that they had made too many "repository imports", which names the wrong cause and
 * sends them to look for a problem that does not exist (`share/build-failure.ts`, same lesson).
 */
export class RateLimitedError extends Error {
  readonly statusCode = 429;
  readonly name = 'RateLimitedError';
  readonly isRetryable = true;
  readonly retryAfterSeconds: number;

  constructor(resetAt: number, now: number, subject = 'repository imports') {
    const seconds = Math.max(1, Math.ceil((resetAt - now) / 1000));
    const minutes = Math.ceil(seconds / 60);
    super(`Too many ${subject}. Try again in about ${minutes} minute${minutes === 1 ? '' : 's'}.`);
    this.retryAfterSeconds = seconds;
  }
}

/**
 * Count one call for this user, or throw `RateLimitedError`.
 *
 * `now` is injectable so the tests drive a clock rather than sleeping — a limiter tested with real
 * timers is either slow or flaky, and usually both.
 */
export async function enforceUserRateLimit(input: {
  userId: string;
  bucket: string;
  rule: UserRateLimitRule;

  /**
   * What was throttled, in the user's words — "branch operations", "repository imports".
   *
   * 🔴 **THREADED THROUGH, because this function silently dropped it and that is a defect factory.**
   * `RateLimitedError` has taken a `subject` since it was written, with a comment explaining exactly
   * why; this function constructed the error with two arguments and let the default win. So the
   * parameter existed, was documented, was tested at the class — and was unreachable through THIS
   * function, which is how every bucket routed through it would have inherited "repository imports"
   * and named the wrong operation (`share/build-failure.ts`: the same class of defect as naming no
   * cause at all — the user goes looking for a problem that does not exist).
   *
   * ⚠️ Not "the only place that throws it": `licensing/unity-api-key.ts` constructs the error itself,
   * deliberately bypassing this function because it keys on an IP fingerprint rather than a user id,
   * and it has always passed its own subject. Stated because the tempting summary — "no production
   * 429 has ever named anything but repository imports" — is untrue, and a future reader would act
   * on it.
   *
   * Optional, so every existing call site keeps its exact wording rather than being migrated in a
   * task that is not about them.
   */
  subject?: string;
  now?: number;
}): Promise<void> {
  const now = input.now ?? Date.now();
  const decision = await getUserRateLimitStore().hit(`${input.bucket}:${input.userId}`, input.rule, now);

  if (!decision.allowed) {
    logger.warn(
      `Rate limited ${input.bucket} for user ${input.userId} until ${new Date(decision.resetAt).toISOString()}`,
    );
    throw new RateLimitedError(decision.resetAt, now, input.subject);
  }
}
