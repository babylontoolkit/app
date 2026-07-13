/**
 * The active game registry (SPEC §4.4) — cards on the New Project screen, and the keyword set the
 * client scores a typed prompt against (§4.4a Path A).
 *
 * Served rather than imported so that when the rows move to Supabase in Stage 3 the client does not
 * change at all. Public data: genre copy and keywords, no secrets.
 */
import { json } from '@remix-run/cloudflare';
import { getGameRegistry } from '~/lib/.server/templates/registry';

export async function loader() {
  const entries = await getGameRegistry().list();

  return json({ entries });
}
