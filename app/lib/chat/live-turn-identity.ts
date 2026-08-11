/**
 * The ONE place that reads the live identity stores at send time.
 *
 * Split from `turn-identity.ts` so the decision stays pure and unit-testable while the store access
 * lives here — and so there is exactly one reader. Five send paths need this value (the composer, the
 * auto-repair `append`, the `?prompt=` deep link, "Build & Apply" and "Build this plan"); five inline
 * `projectId.get()` calls is the two-writers drift this codebase keeps rediscovering, and here the
 * failure is silent (see `turn-identity.ts` for the measurement).
 */
import { chatMetadata, projectId } from '~/lib/persistence';
import { createScopedLogger } from '~/utils/logger';
import { resolveTurnIdentity, type TurnIdentity } from './turn-identity';

const logger = createScopedLogger('TurnIdentity');

/**
 * What this turn should claim, right now.
 *
 * `captured` is whatever the calling component had from render — passed in so the resolver can report
 * a disagreement. Callers with nothing captured pass nothing.
 */
export function liveTurnIdentity(captured: TurnIdentity = {}): TurnIdentity {
  /*
   * ⚠️ The stores are read through optional access because this runs on EVERY send, including from
   * component tests that mock `~/lib/persistence` partially. A missing store there threw an uncaught
   * `Cannot read properties of undefined` that failed unrelated suites — and a helper whose whole job
   * is to make sends more reliable must not be the thing that breaks one. In the app both stores are
   * module singletons and always present, so this only ever degrades to the captured value.
   */
  const { identity, stale } = resolveTurnIdentity(captured, {
    projectId: projectId?.get?.(),
    chatId: chatMetadata?.get?.()?.serverChatId,
  });

  if (stale) {
    /*
     * Loud on purpose: this is the render-timing window closing correctly, but a session that hits it
     * repeatedly means something upstream is resetting the store and should be found rather than
     * papered over. Silence here is what let the original bug run.
     */
    logger.warn(
      `Recovered turn identity from the live store (render had project=${String(captured.projectId)}, sending project=${String(identity.projectId)})`,
    );
  }

  return identity;
}
