import type { AppLoadContext } from '@remix-run/cloudflare';
import { RemixServer } from '@remix-run/react';
import { isbot } from 'isbot';
import { renderToReadableStream } from 'react-dom/server';
import { renderHeadToString } from 'remix-island';
import { Head } from './root';
import { themeStore } from '~/lib/stores/theme';
import { assertNotLocalInProduction } from '~/lib/.server/supabase/auth';
import { resolveSandboxProviderId, SANDBOX_PROVIDER_TRAITS } from '~/lib/common/sandbox-runtime';

/**
 * THE BOOT GATE (SPEC §4.5).
 *
 * Local mode treats every caller as a VERIFIED ADMIN — that is what makes it useful for development
 * and catastrophic in production. It engages purely from the absence of `SUPABASE_URL` /
 * `SUPABASE_ANON_KEY`, so a typo'd SSM path or a dropped container variable is all it takes for a
 * production deploy to hand admin to the public internet.
 *
 * This must run at BOOT, at module scope, not on the first authenticated request. A per-request check
 * lets the process come up healthy, pass its health check, take traffic, and serve every route that
 * never happens to call `getUser` — the webhook, the admin route, every public loader. Refusing to
 * start is the only version of this check that actually holds.
 */
assertNotLocalInProduction();

export default async function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  remixContext: any,
  _loadContext: AppLoadContext,
) {
  // await initializeModelList({});

  const readable = await renderToReadableStream(<RemixServer context={remixContext} url={request.url} />, {
    signal: request.signal,
    onError(error: unknown) {
      console.error(error);
      responseStatusCode = 500;
    },
  });

  const body = new ReadableStream({
    start(controller) {
      const head = renderHeadToString({ request, remixContext, Head });

      controller.enqueue(
        new Uint8Array(
          new TextEncoder().encode(
            `<!DOCTYPE html><html lang="en" data-theme="${themeStore.value}"><head>${head}</head><body><div id="root" class="w-full h-full">`,
          ),
        ),
      );

      const reader = readable.getReader();

      function read() {
        reader
          .read()
          .then(({ done, value }) => {
            if (done) {
              controller.enqueue(new Uint8Array(new TextEncoder().encode('</div></body></html>')));
              controller.close();

              return;
            }

            controller.enqueue(value);
            read();
          })
          .catch((error) => {
            controller.error(error);
            readable.cancel();
          });
      }
      read();
    },

    cancel() {
      readable.cancel();
    },
  });

  if (isbot(request.headers.get('user-agent') || '')) {
    await readable.allReady;
  }

  responseHeaders.set('Content-Type', 'text/html');

  /*
   * COEP `require-corp` exists ONLY for WebContainer — it is what turns on SharedArrayBuffer, which
   * that runtime needs to exist at all. It is also a wall: under require-corp, a cross-origin iframe
   * whose response carries no `Cross-Origin-Resource-Policy` header is refused outright
   * (ERR_BLOCKED_BY_RESPONSE). StackBlitz's preview hosts send CORP for exactly this reason;
   * CodeSandbox's `*.csb.app` previews do not (MEASURED live — the workbench preview rendered
   * "refused to connect" over a healthy, token-authorized dev server). A CodeSandbox build boots no
   * WebContainer, needs no SharedArrayBuffer, and must not pay the embedding restriction — this is
   * the incidental win `spec/sandbox-seam.md` names ("dropping WebContainer lets us drop COEP").
   * Same build-time switch as `~/lib/sandbox/index.ts`; the header follows the runtime it serves.
   *
   * ✅ **The negation is GONE (2026-07-31).** This used to read `!== 'codesandbox'`, and the note here
   * said: *"a future provider that does NOT want isolation inherits it silently… when the third
   * provider lands, make this a property of the provider rather than a list of the ones that do not."*
   * Nodepod is that third provider, so the answer now comes from `SANDBOX_PROVIDER_TRAITS`, where the
   * type will not compile until a new runtime has stated whether it needs isolation. Nodepod happens
   * to want it (its sync VFS bridge is `Atomics.wait` over a SharedArrayBuffer), which is exactly why
   * making it explicit mattered — a coincidence that keeps working teaches nobody anything.
   *
   * NOTE: `require-corp` here is about the RUNTIME, never about the game. Havok does not need
   * SharedArrayBuffer (SPEC §4.4, corrected 2026-07-31, measured against the shipped wasm).
   */
  if (
    SANDBOX_PROVIDER_TRAITS[resolveSandboxProviderId(import.meta.env.VITE_SANDBOX_PROVIDER)].needsCrossOriginIsolation
  ) {
    responseHeaders.set('Cross-Origin-Embedder-Policy', 'require-corp');
    responseHeaders.set('Cross-Origin-Opener-Policy', 'same-origin');
  }

  return new Response(body, {
    headers: responseHeaders,
    status: responseStatusCode,
  });
}
