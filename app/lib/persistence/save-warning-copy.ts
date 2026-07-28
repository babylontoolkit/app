/**
 * What the save nudges SAY, and why it depends on the runtime (SPEC §4.5.4b, `spec/sandbox-seam.md`).
 *
 * ## The bug this fixes
 *
 * The nudges shipped one sentence for both providers:
 *
 *   > It exists ONLY in this browser tab. If you clear your browsing data or switch devices, it is gone.
 *
 * On WebContainer that is literally true — the filesystem dies with the tab. On a server-backed
 * provider it is FALSE: the files sit on a remote disk that outlives the page, and a resumed session
 * boots straight back into them (`bootRestoredFilesystem`). A user who clears their cache, reopens the
 * project and finds their game intact has just been shown that the scary warning was wrong.
 *
 * That is worse than saying nothing, because **the conclusion is still correct**. A sandbox VM is a
 * workspace, not a backup: it can be reset, reclaimed or replaced, the platform deliberately stores no
 * project files (§4.5.4b), and the only durable home for the user's game is their own repository. A
 * warning disproved on its details gets ignored on its substance.
 *
 * ## The rule
 *
 * The ACTION never changes — every branch ends at "save it to your own GitHub account". Only the
 * REASON is provider-specific, because only the reason is what differs. Do not let a future edit make
 * one branch softer than the other: an unsaved project is equally unsafe in both, for different
 * reasons.
 *
 * Pure and tested for the same reason `save-status.ts` is: this is the copy standing between a user
 * and losing their only copy of something they made, and its two variants must not drift.
 */

export interface SaveWarningCopy {
  /**
   * The one-time per-project toast (§4.5.4b), split where the component bolds it.
   *
   * Split HERE rather than in the component: the toast renders its first sentence in bold, and doing
   * that with `text.split('.')[0]` at the call site makes a punctuation mark load-bearing — the day a
   * sentence gains an abbreviation the headline silently truncates mid-phrase.
   */
  toastHeadline: string;
  toastDetail: string;

  /** The recurring milestone banner. */
  banner: string;
}

/** The whole toast as one string — for tests and any surface that does not style the headline. */
export function toastText(copy: SaveWarningCopy): string {
  return `${copy.toastHeadline} ${copy.toastDetail}`;
}

export interface SaveWarningInput {
  /**
   * Does the sandbox filesystem survive this browser session? (`SANDBOX_OUTLIVES_SESSION`.)
   *
   * Note this is about the SANDBOX, never about whether the work is SAFE — it is not safe in either
   * case, which is the whole point of the nudge.
   */
  sandboxOutlivesSession: boolean;
}

/** Shared across both runtimes on purpose — an unsaved project is equally unsafe in either. */
const SAVE_HEADLINE = 'Save your work — this game is not saved yet.';
const SAVE_CALL_TO_ACTION = 'Save it to your own GitHub account to keep it safe on any device.';

export function saveWarningCopy({ sandboxOutlivesSession }: SaveWarningInput): SaveWarningCopy {
  if (sandboxOutlivesSession) {
    return {
      toastHeadline: SAVE_HEADLINE,

      /*
       * "Temporary workspace" rather than "this browser": accurate, and it names the actual risk. "We
       * do not keep a copy" is the part users do not expect and is the reason saving matters — §4.5.4b
       * is a deliberate design choice, not an omission, so it is worth stating plainly.
       */
      toastDetail:
        'It lives in a temporary cloud workspace that can be reset or reclaimed at any time, and we do ' +
        `not keep a copy of your files. ${SAVE_CALL_TO_ACTION}`,
      banner:
        'This project lives in a temporary workspace and we do not keep a copy of your files. Saving puts it ' +
        'in your own GitHub account, where it stays yours.',
    };
  }

  return {
    toastHeadline: SAVE_HEADLINE,
    toastDetail:
      'It exists only in this browser tab. If you clear your browsing data or switch devices, it is gone. ' +
      SAVE_CALL_TO_ACTION,
    banner:
      'This project is only in this browser. If you clear your browsing data or switch devices, it is gone. ' +
      'Saving puts it in your own GitHub account, where it stays yours.',
  };
}
