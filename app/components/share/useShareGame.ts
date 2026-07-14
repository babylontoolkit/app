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
import { webcontainer } from '~/lib/webcontainer';
import { workbenchStore } from '~/lib/stores/workbench';
import { projectId as projectIdStore } from '~/lib/persistence';
import { path } from '~/utils/path';
import { bytesToBase64, isBinaryPath } from '~/lib/binary/binary-files';
import type { SerializedFileMap } from '~/lib/binary/binary-files';
import type { ActionCallbackData } from '~/lib/runtime/message-parser';
import type { ChecklistFinding } from '~/types/share';

export interface PublishOptions {
  title?: string;
  description?: string;
  submitToGallery?: boolean;

  /** Set once the user has seen and accepted non-blocking warnings. */
  acknowledgeWarnings?: boolean;
}

export type ShareOutcome =
  | { status: 'published'; shareId: string }
  | { status: 'blocked'; findings: ChecklistFinding[] }
  | { status: 'needs-acknowledgement'; findings: ChecklistFinding[] }
  | { status: 'error'; message: string };

/** Read a built output directory into a byte-faithful SerializedFileMap (the publish route's input). */
async function readDist(finalBuildPath: string): Promise<SerializedFileMap> {
  const container = await webcontainer;
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

/** Run `npm run build` in the WebContainer and return the output directory, or throw with the log. */
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
    action: { type: 'build' as const, content: 'npm run build' },
  };

  artifact.runner.addAction(actionData);
  await artifact.runner.runAction(actionData);

  const buildOutput = artifact.runner.buildOutput;

  if (!buildOutput || buildOutput.exitCode !== 0) {
    throw new Error('The project failed to build. Fix the errors in the editor and try again.');
  }

  // Find the real output directory (Vite → dist), the same way the deploy flow does.
  const container = await webcontainer;
  const candidates = [buildOutput.path.replace('/home/project', ''), '/dist', '/build', '/out', '/output'];

  for (const dir of candidates) {
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

    setIsPublishing(true);

    try {
      const buildPath = await buildProject();
      const dist = await readDist(buildPath);

      const response = await fetch(`/api/projects/${activeProjectId}/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dist, ...options }),
      });

      const data = (await response.json()) as {
        shareId?: string;
        findings?: ChecklistFinding[];
        needsAcknowledgement?: boolean;
        message?: string;
      };

      if (response.status === 201 && data.shareId) {
        return { status: 'published', shareId: data.shareId };
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
      return { status: 'error', message: error instanceof Error ? error.message : 'Publishing failed.' };
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
