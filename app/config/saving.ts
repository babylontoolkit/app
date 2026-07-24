/**
 * How insistently the platform asks the user to save (SPEC §4.5.4b).
 *
 * Config, not constants in a component, because these are the numbers an operator tunes after watching
 * real users lose real work — or after watching them get annoyed. They are deliberately small and
 * deliberately here.
 *
 * The one rule that is NOT tunable, because it is a product promise rather than a dial: a nudge is
 * MILESTONE-based, never TIMED, and never blocks a generation. A timer that fires mid-thought while
 * someone is describing their game is an interruption they did not earn; "you have made five things
 * and none of them are saved" is information they asked for by making five things.
 */
export const saving = {
  /**
   * Show the dismissible banner every N generations while a project is still browser-only.
   *
   * Counted in generations rather than minutes for the reason above. At 5 the user has a project worth
   * losing; much lower and it reads as nagging before there is anything at stake.
   */
  bannerEveryNGenerations: 5,

  /**
   * The toast after EACH PROJECT's first successful creation (§4.5.4b) — per project, not per user.
   *
   * Every new game is one cleared-cache or device-switch away from being lost until it is saved to a
   * repo, so this fires for every project the user creates, not once in their lifetime. It is the moment
   * they have something they would miss and no idea it lives only in this browser tab.
   */
  toastAfterFirstCreation: true,

  /**
   * How long that toast stays up, in ms — or `false` to keep it until the user acts or dismisses it.
   *
   * Deliberately LONG and loud: this is the one moment the only copy of the user's work sits in a tab
   * they might close. A 5-second toast they can miss is worse than useless here.
   */
  introToastAutoCloseMs: 60_000 as number | false,
} as const;
