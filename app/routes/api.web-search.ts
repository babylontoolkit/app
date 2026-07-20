/**
 * "Fetch URL content" — server-side scrape of a user-supplied URL (the chat globe button).
 *
 * This route reaches OUT to the public internet on the platform's behalf, so it is two things that
 * must both hold: authenticated (an anonymous open fetch-proxy is abuse of our bandwidth and IP
 * reputation, the same shape as the Stage-3 unmetered holes) and SSRF-safe (a server that fetches a
 * caller-chosen URL can be aimed at cloud metadata / private services unless it refuses every
 * non-public target — including across redirects and DNS). The fetch/SSRF/extract core is shared with
 * the agent's `web_fetch` tool in `net/fetch-url.ts` — ONE implementation on this SSRF-sensitive path.
 *
 * It does NOT touch the LLM and spends no credits: the fetched text lands in the user's chat input,
 * and is billed only if/when they send it as an ordinary message through `/api/agent`.
 */
import { json } from '@remix-run/cloudflare';
import type { ActionFunctionArgs } from '@remix-run/cloudflare';
import { requireVerifiedUser } from '~/lib/.server/supabase/auth';
import { errorResponse } from '~/lib/.server/http';
import { scrapeUrl } from '~/lib/.server/net/fetch-url';

export async function action({ request, context }: ActionFunctionArgs) {
  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, { status: 405 });
  }

  try {
    // Authenticated + verified: an anonymous open fetch-proxy is bandwidth/IP-reputation abuse.
    await requireVerifiedUser(request, context);

    const { url } = (await request.json()) as { url?: string };

    if (!url || typeof url !== 'string') {
      return json({ error: 'URL is required' }, { status: 400 });
    }

    const result = await scrapeUrl(url);

    if (!result.ok) {
      return json({ error: result.error }, { status: result.status });
    }

    return json({
      success: true,
      data: {
        title: result.title,
        description: result.description,
        content: result.content,
        sourceUrl: result.sourceUrl,
      },
    });
  } catch (error) {
    // Auth failures (401/403) come back with their safe messages via the shared helper.
    const status = (error as { statusCode?: number })?.statusCode;

    if (status === 401 || status === 403) {
      return errorResponse(error);
    }

    return json({ error: error instanceof Error ? error.message : 'Failed to fetch URL' }, { status: 500 });
  }
}
