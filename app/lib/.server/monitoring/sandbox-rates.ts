/**
 * Rates on the sandbox path (plan T13, SPEC §5A, `spec/sandbox-codesandbox.md`).
 *
 * `app/lib/.server/sandbox/*` imported no monitoring at all until this module. Every failure there was
 * a `logger.warn` — invisible in production — on the path that decides whether a user can open their
 * project at all, and on the path that spends money by the second. The same argument
 * `paid-path-rates.ts` opens with applies unchanged: a signal nobody watches is not a signal.
 *
 * Three windows, and the third is the interesting one:
 *
 *   - **`sandbox:create`** — forking a VM. A rising rate is "nobody can start a new project".
 *   - **`sandbox:resume`** — waking one. A rising rate is "nobody can open the project they have".
 *   - **`sandbox:clean-boot`** — a resume that came back `CLEAN`. **Not a failure.** The request
 *     succeeded, the user got a working sandbox, and nothing in the failure windows will ever show it.
 *     But `CLEAN` means the hibernation snapshot had expired and setup re-ran, so the FILES are
 *     template state and the §4.5.4c working copy has to refill them. It is the closest thing this
 *     subsystem has to a data-loss signal, and it is invisible by construction — which is exactly the
 *     shape of every metric this codebase has watched die reporting zero.
 *
 * ⚠️ **Record EVERY attempt, not just the failures.** A window fed only its failures reads 100% and
 * alerts on the first one, which is how a rate turns into a per-event alarm somebody switches off
 * (`proxy.ts`'s own warning, and the reason `recordRescueMarkers` documents the same thing).
 *
 * Shape copied deliberately from `paid-path-rates.ts`: bounded in-process ring buffers via
 * `sharedRateWindow`, no database read (the alert must fire when the database is what is down), and
 * the judgement lives in `FailureRateWindow`, which is pure and separately tested. Nothing here may
 * throw into a request — `Monitor` never throws, and these functions add no failure of their own.
 */
import type { Monitor } from './index';
import { ALERT_SIGNALS } from './events';
import { sharedRateWindow, type FailureRateConfig } from './failure-rate';

/** The two ways a session request can reach the provider. Each gets its own window. */
export type SandboxAttemptKind = 'create' | 'resume';

/**
 * Sandbox calls are expected to SUCCEED — unlike a rescue marker, a failure here has no upside and
 * the user is looking at a broken workbench. So the threshold sits lower than the rescue windows
 * (0.3 vs 0.25 is close, but the minimum sample count is what differs in practice): a fifth of opens
 * failing is already a visible outage to the people it happens to.
 *
 * The window is wide because sandbox starts are much rarer than generations — one per project open,
 * not one per turn — so a narrow window would swing over the threshold on two unlucky requests.
 */
const SANDBOX_RATE_CONFIG: FailureRateConfig = {
  minSamples: 8,
  threshold: 0.3,
  windowSize: 40,
  cooldownSamples: 40,
};

/**
 * A CLEAN resume is not a failure, so it gets its own threshold rather than borrowing one.
 *
 * Some are unavoidable: a project untouched for long enough loses its snapshot, and that is the
 * provider working as documented. A QUARTER of resumes coming back CLEAN means snapshots are expiring
 * far faster than the hibernation config implies, and every one of those users is relying on the
 * working copy to refill a project that briefly looked like a fresh template.
 */
const CLEAN_BOOT_RATE_CONFIG: FailureRateConfig = {
  minSamples: 8,
  threshold: 0.25,
  windowSize: 40,
  cooldownSamples: 40,
};

/**
 * Record one create-or-resume attempt. `failed` is required, and callers pass `false` on success —
 * see the "record every attempt" warning above.
 */
export function recordSandboxOutcome(monitor: Monitor, kind: SandboxAttemptKind, failed: boolean): void {
  const result = sharedRateWindow(`sandbox:${kind}`, SANDBOX_RATE_CONFIG).record(failed);

  if (result.shouldAlert) {
    monitor.alert(
      ALERT_SIGNALS.SANDBOX_FAILURE_RATE,
      `${(result.rate * 100).toFixed(0)}% of recent sandbox ${kind}s failed ` +
        `(${result.failures}/${result.window}) — users cannot ${kind === 'create' ? 'start new projects' : 'open their projects'}.`,
      { severity: 'critical', scope: 'sandbox-rates', tags: { kind } },
    );
  }
}

/**
 * Record how a RESUME came back. `wasClean` means the snapshot was gone and the files are template
 * state — a success with a cost, which is why it is a separate window and a warning, not a critical.
 *
 * Only resumes belong here. A fresh fork is template state by definition, so feeding creates into
 * this window would bury the signal under the very thing it is trying to distinguish from.
 */
export function recordSandboxCleanBoot(monitor: Monitor, wasClean: boolean): void {
  const result = sharedRateWindow('sandbox:clean-boot', CLEAN_BOOT_RATE_CONFIG).record(wasClean);

  if (result.shouldAlert) {
    monitor.alert(
      ALERT_SIGNALS.SANDBOX_CLEAN_BOOT_RATE,
      `${(result.rate * 100).toFixed(0)}% of recent sandbox resumes came back CLEAN ` +
        `(${result.failures}/${result.window}) — those projects were restored from the working copy, ` +
        `not from the VM. Snapshots are expiring faster than the hibernation config implies.`,
      { severity: 'warning', scope: 'sandbox-rates' },
    );
  }
}
