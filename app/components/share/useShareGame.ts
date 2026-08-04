/**
 * The client half of Share (SPEC §4.8).
 *
 * Publishing is: run `npm run build` in the user's WebContainer (the server NEVER executes user code,
 * §5), read the resulting `dist/` as a byte-faithful `SerializedFileMap`, and POST it to
 * `/api/projects/:id/publish`. The server re-runs the publishing checklist on those exact bytes and,
 * if nothing is blocking, uploads them and mints the share id.
 *
 * The build-and-read machinery is the SAME one the deploy buttons use (`useVercelDeploy`) — a `build`
 * action through the artifact runner, then a recursive read of the output directory as bytes. Reusing
 * it is deliberate: the binary-faithfulness (base64 for every image/font/wasm) is already proven there,
 * and a share that shipped corrupted assets would be worse than no share (§4.8).
 *
 * This hook owns only the async flow and its states; the dialog renders them. It surfaces the two
 * non-success outcomes the checklist produces — a blocking refusal (a secret) and warnings the user may
 * accept — so the dialog can show them rather than a generic failure.
 */
import { useState } from 'react';
import { toast } from 'react-toastify';
import { useStore } from '@nanostores/react';
import { sandbox } from '~/lib/sandbox';
import { workbenchStore } from '~/lib/stores/workbench';
import { projectId as projectIdStore } from '~/lib/persistence';
import { path } from '~/utils/path';
import { bytesToBase64, isBinaryPath } from '~/lib/binary/binary-files';
import type { SerializedFileMap } from '~/lib/binary/binary-files';
import type { ActionCallbackData } from '~/lib/runtime/message-parser';
import type { ChecklistFinding } from '~/types/share';
import { buildOutputCandidates } from '~/lib/sandbox/build-output';
import { SHARE_BUILD_COMMAND } from '~/lib/runtime/build-command';
import { streamingState } from '~/lib/stores/streaming';
import { decidePublishReadiness } from '~/lib/chat/publish-readiness';
import { describeBuildFailure } from '~/lib/share/build-failure';

/**
 * A build that failed, carrying the compiler log.
 *
 * A plain `Error` has one string, and the whole defect being fixed here is that one string was all
 * the user ever got (`build-failure.ts`). The class exists so the log survives the throw.
 */
class BuildFailedError extends Error {
  constructor(
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'BuildFailedError';
  }
}

export interface PublishOptions {
  title?: string;
  description?: string;
  submitToGallery?: boolean;

  /** Set once the user has seen and accepted non-blocking warnings. */
  acknowledgeWarnings?: boolean;
}

/**
 * On `published`, `remixBlockedReason` is set when the game published fine but its source could not be
 * stored — too large, or absent (§4.8). The publish deliberately still succeeds; what changed is that
 * the user is TOLD. It used to be a line in a server log, so a public, playable, permanently
 * un-remixable game looked identical to a healthy one until a stranger clicked Remix and got an empty
 * editor.
 */
export type ShareOutcome =
  | {
      status: 'published';
      shareId: string;

      /**
       * The public URL, exactly as the server minted it (`shareUrl`, from `SHARE_DOMAIN`). Absolute in
       * production, a relative `/app/<id>` in local dev — either way a finished string this client
       * renders and never rebuilds. See `ShareDialog`'s `existingShareUrl` for why it cannot be
       * computed here.
       */
      url?: string;
      remixBlockedReason?: string;
    }
  | { status: 'blocked'; findings: ChecklistFinding[] }
  | { status: 'needs-acknowledgement'; findings: ChecklistFinding[] }

  /**
   * `detail` is the build log when the build is what failed — the compiler's own words, which name
   * the file and line. It is ADDITIVE: `message` always stands alone, so a surface that renders only
   * the message is still correct, merely less useful.
   */
  | { status: 'error'; message: string; detail?: string };

/** Read a built output directory into a byte-faithful SerializedFileMap (the publish route's input). */
async function readDist(finalBuildPath: string): Promise<SerializedFileMap> {
  const container = await sandbox;
  const files: SerializedFileMap = {};

  async function walk(dirPath: string): Promise<void> {
    const entries = await container.fs.readdir(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);

      if (entry.isFile()) {
        const bytes = await container.fs.readFile(fullPath);
        const relative = fullPath.replace(finalBuildPath, '').replace(/^\/+/, '');
        const binary = isBinaryPath(fullPath);

        files[relative] = {
          type: 'file',
          isBinary: binary,
          content: binary ? bytesToBase64(bytes) : new TextDecoder().decode(bytes),
          size: bytes.byteLength,
        };
      } else if (entry.isDirectory()) {
        await walk(fullPath);
      }
    }
  }

  await walk(finalBuildPath);

  return files;
}

/**
 * Run the SHARE build in the sandbox and return the output directory, or throw with the log.
 *
 * `SHARE_BUILD_COMMAND` passes `--base=./` on the CLI (T17b): a share is served under `/play/<id>/`,
 * and the template's `base: "/"` made every published game request `/index.js` at the origin root —
 * a 404 whose body is the builder's own HTML shell, i.e. a game that publishes fine and never boots.
 * The CLI flag overrides the project's vite config, so this repairs existing projects too.
 */
async function buildProject(): Promise<string> {
  const artifact = workbenchStore.firstArtifact;

  if (!artifact) {
    throw new Error('No active project to build.');
  }

  const actionId = 'share-build-' + Date.now();
  const actionData: ActionCallbackData = {
    messageId: 'share build',
    artifactId: artifact.id,
    actionId,
    action: { type: 'build' as const, content: SHARE_BUILD_COMMAND },
  };

  artifact.runner.addAction(actionData);
  await artifact.runner.runAction(actionData);

  const buildOutput = artifact.runner.buildOutput;

  if (!buildOutput || buildOutput.exitCode !== 0) {
    /*
     * 🔴 The compiler log travels. This used to throw a hardcoded sentence and drop `buildOutput`
     * entirely, so a project that simply did not compile produced "fix the errors in the editor"
     * with nothing naming the error — and the only conclusion available to the user was that Share
     * was broken (`build-failure.ts` records the live case). A stalled build is still NOT a broken
     * project (`build-stall.ts`); `describeBuildFailure` keeps the two apart.
     */
    const failure = describeBuildFailure({
      exitCode: buildOutput?.exitCode ?? 1,
      output: buildOutput?.output ?? '',
      stalledReason: buildOutput?.stalledReason,
    });

    throw new BuildFailedError(failure.message, failure.detail);
  }

  const container = await sandbox;

  for (const dir of buildOutputCandidates(buildOutput.path)) {
    try {
      await container.fs.readdir(dir);
      return dir;
    } catch {
      continue;
    }
  }

  throw new Error('Could not find the build output directory.');
}

export function useShareGame() {
  const [isPublishing, setIsPublishing] = useState(false);
  const activeProjectId = useStore(projectIdStore);

  const publish = async (options: PublishOptions): Promise<ShareOutcome> => {
    if (!activeProjectId) {
      toast.error('Save your project before sharing it.');
      return { status: 'error', message: 'No active project.' };
    }

    /*
     * Refuse to build while a generation is streaming or file actions are still applying (T17):
     * publishing mid-write ships a half-written game with a green "Build Completed" over it.
     */
    const readiness = decidePublishReadiness({
      streaming: streamingState.get(),
      actions: Object.values(workbenchStore.firstArtifact?.runner.actions.get() ?? {}).map((action) => ({
        status: action.status,
        type: action.type,
      })),
    });

    if (!readiness.ready) {
      toast.warn(readiness.reason);
      return { status: 'error', message: readiness.reason ?? 'The project is still being written.' };
    }

    setIsPublishing(true);

    try {
      const buildPath = await buildProject();
      const dist = await readDist(buildPath);

      /*
       * The SOURCE travels too, so the game can be remixed (§4.8, §4.5.4b).
       *
       * Under repo-primary persistence the platform holds no copy of anyone's project, and the owner's
       * repo is private — so this is the only moment a remixable copy can exist, and this browser is
       * the only party that has one. Without it, remixing a shared game silently produces an empty
       * project. The server strips the `.env` family (`buildRemixSeed`) before storing any of it.
       */
      const source = await workbenchStore.serializeFiles();

      const response = await fetch(`/api/projects/${activeProjectId}/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dist, source, ...options }),
      });

      const data = (await response.json()) as {
        shareId?: string;
        url?: string;
        remixable?: boolean;
        remixBlockedReason?: string;
        findings?: ChecklistFinding[];
        needsAcknowledgement?: boolean;
        message?: string;
      };

      if (response.status === 201 && data.shareId) {
        return {
          status: 'published',
          shareId: data.shareId,
          url: data.url,
          remixBlockedReason: data.remixBlockedReason,
        };
      }

      // A secret — a refusal, not a warning (§4.8).
      if (response.status === 422 && data.findings) {
        return { status: 'blocked', findings: data.findings };
      }

      // Debug overlays etc — the user must see them once, then may proceed.
      if (response.status === 409 && data.needsAcknowledgement) {
        return { status: 'needs-acknowledgement', findings: data.findings ?? [] };
      }

      return { status: 'error', message: data.message ?? 'Publishing failed. Please try again.' };
    } catch (error) {
      return {
        status: 'error',
        message: error instanceof Error ? error.message : 'Publishing failed.',
        detail: error instanceof BuildFailedError ? error.detail : undefined,
      };
    } finally {
      setIsPublishing(false);
    }
  };

  const unpublish = async (): Promise<boolean> => {
    if (!activeProjectId) {
      return false;
    }

    setIsPublishing(true);

    try {
      const response = await fetch(`/api/projects/${activeProjectId}/publish`, { method: 'DELETE' });
      return response.ok;
    } finally {
      setIsPublishing(false);
    }
  };

  return { isPublishing, publish, unpublish, canShare: Boolean(activeProjectId) };
}
