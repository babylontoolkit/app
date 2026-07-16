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
   * The one-time toast after a user's FIRST successful creation.
   *
   * This is the moment the product has proven itself and the user has something they would miss — and
   * it is also the moment they have no idea it lives only in this browser tab.
   */
  toastAfterFirstCreation: true,
} as const;
