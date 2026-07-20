/**
 * `web_fetch` — the model's server-side tool for pulling a public web page into a generation (SPEC §4.2).
 *
 * The platform CAN reach the internet at generation time (the server runs the tool loop); what it must
 * never be is an SSRF primitive or an unbounded context bill. Both are handled by the shared core in
 * `net/fetch-url.ts`: every hop is re-validated against the SSRF allow-list + DNS guard, and the
 * returned text is capped. This tool is a thin, NON-THROWING wrapper — a bad URL or a refused target is
 * a model mistake it should recover from inside the same generation (a friendly tool_result string),
 * never a thrown error that kills the paid generation (the lesson `tools.ts` records for every skill
 * tool: validate in `execute`, never in the schema).
 *
 * Scope note: this is for arbitrary URLs the USER references ("look at this site/doc"). It is NOT how
 * the Babylon Toolkit Agent Reference reaches the model — those docs are pre-baked and pinned per
 * prompt version (§4.3), and the prompt tells the model not to web_fetch them.
 */
import { tool } from 'ai';
import { z } from 'zod';
import { createScopedLogger } from '~/utils/logger';
import { scrapeUrl } from '~/lib/.server/net/fetch-url';

const logger = createScopedLogger('web-fetch-tool');

export function createWebFetchTool() {
  return {
    web_fetch: tool({
      description:
        'Fetch a public HTTP/HTTPS web page and return its readable text (title, description, and main ' +
        'content). Use it when the user references a URL or asks you to look at a page/doc online. ' +
        'Returns extracted text, not raw HTML, and only for public pages — private/internal addresses are ' +
        'refused. Do NOT use it for the Babylon Toolkit Agent Reference: those docs are already in your ' +
        'context.',

      /*
       * `.optional()` and validated below, not `z.string().url()`. A zod violation is enforced by the AI
       * SDK BEFORE `execute` runs and throws `InvalidToolArgumentsError`, which aborts the stream and
       * kills the generation after the tokens are already spent (see `tools.ts`). A malformed URL is a
       * recoverable model mistake — handle it in `execute`.
       */
      parameters: z.object({
        url: z.string().optional().describe('The full public URL to fetch, including https://'),
      }),
      execute: async ({ url }) => {
        if (!url) {
          return 'web_fetch needs a "url" — a full public HTTP/HTTPS address, e.g. https://example.com.';
        }

        const result = await scrapeUrl(url);

        if (!result.ok) {
          logger.warn(`web_fetch(${url}) failed: ${result.status} ${result.error}`);
          return `Could not fetch ${url}: ${result.error}`;
        }

        logger.info(`web_fetch(${url}) → ${result.content.length} chars`);

        const header = [
          result.title && `Title: ${result.title}`,
          result.description && `Description: ${result.description}`,
        ]
          .filter(Boolean)
          .join('\n');

        return `Fetched ${result.sourceUrl}\n${header ? header + '\n\n' : ''}${result.content || '(no readable text content)'}`;
      },
    }),
  };
}
