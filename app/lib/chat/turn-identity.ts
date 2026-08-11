/**
 * WHICH PROJECT AND CHAT A TURN BELONGS TO — resolved at SEND time, not at render time.
 *
 * ## Why this exists (measured live, 2026-08-10)
 *
 * Two consecutive turns, 117 seconds apart, same project open on screen the whole time:
 *
 *   08:26:55  projectId: prj_20260810070411_sq2i7vx0   8 tool rounds, drove the game
 *   08:28:52  projectId: undefined                     1 round, "I do not have evaluate_in_game"
 *
 * The AI SDK builds its request body from COMMITTED RENDER STATE (`useChat` refreshes it from a
 * `useEffect`). `projectId` is a `useStore` capture, so between a page load and the commit that
 * carries the mounted project, a send posts `projectId: undefined` — while the workbench, the file
 * tree and the running preview are all sitting there looking perfectly attached.
 *
 * 🔴 **The damage is silent and it is not one feature.** `previewTools`, the media-generation tools
 * and the MCP relay tools are ALL gated on `request.projectId` in the proxy, so a turn without it
 * loses three tool families at once, bills normally, and says nothing. The only reason it was ever
 * noticed is that the model volunteered "I do not have evaluate_in_game this turn" — a user would
 * reasonably conclude the dev tools are broken. Per-project attribution on the `generations` row and
 * the one-in-flight-build claim go missing with it.
 *
 * This is the same trap CLAUDE.md already records against creation ("an unyielded creation posted
 * `projectId: undefined`"), arriving through a different door: there the state was set too late, here
 * a reload reset it. Fixing the timing at one call site fixes one door. Reading the LIVE store at
 * send time and overriding the request body fixes all of them, including the ones nobody has hit yet.
 *
 * ⚠️ Deliberately NOT a "block the send until it is ready" gate. Refusing to send is a worse failure
 * than sending: it strands a user who typed a message, and it needs its own notion of "is a project
 * supposed to be here" that would be wrong for genuinely project-less chats.
 */

/**
 * The index signature is required, not decorative: this object is spread into the AI SDK's
 * per-request `body`, which is typed `Record<string, unknown>`.
 */
export interface TurnIdentity {
  [key: string]: unknown;
  projectId?: string;
  chatId?: string;
}

export interface ResolvedTurnIdentity {
  identity: TurnIdentity;

  /**
   * The live store disagreed with what render captured — i.e. the body that would have been sent was
   * wrong. Surfaced so the client can log it; a silent correction hides how often this happens.
   */
  stale: boolean;
}

/**
 * Reconcile what React committed with what the stores hold right now.
 *
 * 🔴 **A present value always beats an absent one, in BOTH directions.** The live store wins when it
 * has a value, because it is by definition never older than the render. But when the live store is
 * empty and the render captured an id, the captured one is kept: the failure being fixed is a turn
 * arriving with NO project, so a resolver that can itself produce `undefined` from a defined input
 * would reintroduce it. There is no case where dropping a known id is the safe answer.
 */
export function resolveTurnIdentity(captured: TurnIdentity, live: TurnIdentity): ResolvedTurnIdentity {
  const projectId = live.projectId ?? captured.projectId;
  const chatId = live.chatId ?? captured.chatId;

  return {
    identity: { projectId, chatId },
    stale: projectId !== captured.projectId || chatId !== captured.chatId,
  };
}
