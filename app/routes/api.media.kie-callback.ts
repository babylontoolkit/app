/**
 * KIE's Suno music callback (SPEC §4.16) — a 200 that does nothing, on purpose.
 *
 * KIE's Suno music API REJECTS a create request that carries no `callBackUrl`, even for a caller that
 * polls. So the platform has to own a public address for it. That is the whole reason this route
 * exists, and the reason it is deliberately inert:
 *
 * 🔴 **Polling is the only source of truth.** `pollMediaTask` is what debits, refunds, marks a task
 * terminal and hands the bytes over. A callback that could do any of those would be a second,
 * unauthenticated writer of the money path — and an unauthenticated writer of a money path is a hole
 * however carefully it validates, because anyone can call it. This one reads nothing from the body,
 * so there is nothing to forge: the worst a caller achieves is a 200.
 *
 * It is in `PUBLIC_BY_DESIGN` (`outbound-enumerate.spec.ts`) for that reason, not because a wall was
 * forgotten. It is also not a spend hole (`spec/spend-holes.md`): it makes no outbound call, touches
 * no store and reaches no provider key.
 */
import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from '@remix-run/cloudflare';

export async function action({ request }: ActionFunctionArgs) {
  /*
   * The body is never read. Consuming it would invite a reader to start believing it, which is the
   * only way this route becomes dangerous.
   */
  void request;

  return json({ ok: true });
}

/** KIE has been observed probing a callback with GET before using it; answer the same way. */
export async function loader(_args: LoaderFunctionArgs) {
  return json({ ok: true });
}
