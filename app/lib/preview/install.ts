/**
 * Installing the dev-tools channel, and turning what it reports into what the user and the agent see.
 *
 * Split from `bridge.ts` so the bridge stays a pure transport that a test can drive with two fake
 * windows: this is the module that knows about `workbenchStore` and the alert banner, and importing a
 * store into the transport would make the transport untestable — the shape `execution-queue.ts` was
 * extracted to avoid.
 *
 * ## What this replaces
 *
 * `webcontainer/index.ts` did the equivalent — fetch `inspector-script.js`, `setPreviewScript`, listen
 * for `preview-message`, raise an `actionAlert` — using WebContainer's own event API, outside the
 * sandbox seam. That code is unchanged and still runs on WebContainer, and it is now the SECOND
 * reporter on that provider; the alert de-dupes on message, so a WebContainer user sees one banner.
 * It is left in place rather than deleted per §2.1a hide-don't-delete, and because deleting it is a
 * change to a provider nobody currently builds.
 */
import { workbenchStore } from '~/lib/stores/workbench';
import { createScopedLogger } from '~/utils/logger';
import { buildPreviewAgentScript } from './agent-script';
import { installPreviewAgent, previewErrorsStore } from './bridge';
import type { PreviewErrorEntry } from './protocol';

const logger = createScopedLogger('preview-devtools');

/** Set once the channel is live, so the panel can distinguish "no errors" from "not watching". */
let installed = false;

export function isPreviewDevToolsInstalled(): boolean {
  return installed;
}

interface InstallTarget {
  capabilities: { previewScript: boolean };
  setPreviewScript?: (script: string) => Promise<void>;
}

/**
 * Inject the agent and start turning game errors into the alert the repair loop already consumes.
 *
 * Returns whether the channel is available, so a caller (and the panel) can say "not supported on
 * this runtime" rather than reporting a healthy game that is simply unobserved.
 */
export async function installPreviewDevTools(provider: InstallTarget): Promise<boolean> {
  const ok = await installPreviewAgent(provider, buildPreviewAgentScript());

  if (!ok) {
    return false;
  }

  if (!installed) {
    installed = true;
    watchForErrors();
    logger.info('Preview dev-tools installed');
  }

  return true;
}

/**
 * Raise the existing preview alert when the game throws.
 *
 * 🔴 **`raisedAt` is required, not decoration.** `lib/stores/preview-alert.ts` retires an alert only
 * by comparing its timestamp against the next successful load; an alert without one is PERMANENT, and
 * a transient error (a module request served the SPA fallback while Vite reloads) leaves a banner with
 * a paid "Ask the agent" button sitting next to a working preview. That exact false alarm cost the
 * owner ~300 credits once already.
 */
function watchForErrors() {
  let lastSeen = 0;

  previewErrorsStore.subscribe((entries) => {
    const fresh = entries.filter((entry) => entry.at > lastSeen);

    if (fresh.length === 0) {
      return;
    }

    lastSeen = fresh[fresh.length - 1].at;

    /* The newest one is what the banner describes; the rest are already in the panel's history. */
    const error = fresh[fresh.length - 1];
    workbenchStore.actionAlert.set({
      type: 'preview',
      title: error.type === 'rejection' ? 'Unhandled Promise Rejection' : 'Uncaught Exception',
      description: error.message,
      content: describeError(error),
      source: 'preview',
      raisedAt: error.at,
    });
  });
}

/** The body of the alert — everything a person or the agent needs to place the failure. */
function describeError(error: PreviewErrorEntry): string {
  const where = error.url ? `${error.url}${error.line ? `:${error.line}:${error.column ?? 0}` : ''}` : 'the game';

  return [`Error in ${where}`, '', error.stack || error.message].join('\n');
}
