import { toast } from 'react-toastify';
import { useStore } from '@nanostores/react';
import { workbenchStore } from '~/lib/stores/workbench';
import { webcontainer } from '~/lib/webcontainer';
import { path } from '~/utils/path';
import { useState } from 'react';
import type { ActionCallbackData } from '~/lib/runtime/message-parser';
import { chatId } from '~/lib/persistence/useChatHistory';
import { getLocalStorage } from '~/lib/persistence/localStorage';
import { formatBuildFailureOutput } from './deployUtils';
import { bytesToBase64, isBinaryPath, type DeployFile } from '~/lib/binary/binary-files';
import { brand } from '~/config/brand';

export function useGitHubDeploy() {
  const [isDeploying, setIsDeploying] = useState(false);
  const currentChatId = useStore(chatId);

  const handleGitHubDeploy = async () => {
    const connection = getLocalStorage('github_connection');

    if (!connection?.token || !connection?.user) {
      toast.error('Please connect your GitHub account in Settings > Connections first');
      return false;
    }

    if (!currentChatId) {
      toast.error('No active chat found');
      return false;
    }

    try {
      setIsDeploying(true);

      const artifact = workbenchStore.firstArtifact;

      if (!artifact) {
        throw new Error('No active project found');
      }

      // Create a deployment artifact for visual feedback
      const deploymentId = `deploy-github-project`;
      workbenchStore.addArtifact({
        id: deploymentId,
        messageId: deploymentId,
        title: 'GitHub Deployment',
        type: 'standalone',
      });

      const deployArtifact = workbenchStore.artifacts.get()[deploymentId];

      // Notify that build is starting
      deployArtifact.runner.handleDeployAction('building', 'running', { source: 'github' });

      const actionId = 'build-' + Date.now();
      const actionData: ActionCallbackData = {
        messageId: 'github build',
        artifactId: artifact.id,
        actionId,
        action: {
          type: 'build' as const,
          content: 'npm run build',
        },
      };

      // Add the action first
      artifact.runner.addAction(actionData);

      // Then run it
      await artifact.runner.runAction(actionData);

      const buildOutput = artifact.runner.buildOutput;

      if (!buildOutput || buildOutput.exitCode !== 0) {
        // Notify that build failed
        deployArtifact.runner.handleDeployAction('building', 'failed', {
          error: formatBuildFailureOutput(buildOutput?.output),
          source: 'github',
        });
        throw new Error('Build failed');
      }

      // Notify that build succeeded and deployment preparation is starting
      deployArtifact.runner.handleDeployAction('deploying', 'running', {
        source: 'github',
      });

      // Get all project files instead of just the build directory since we're deploying to a repository
      const container = await webcontainer;

      // Get all files recursively - we'll deploy the entire project, not just the build directory
      async function getAllFiles(dirPath: string, basePath: string = ''): Promise<Record<string, DeployFile>> {
        const files: Record<string, DeployFile> = {};
        const entries = await container.fs.readdir(dirPath, { withFileTypes: true });

        for (const entry of entries) {
          const fullPath = path.join(dirPath, entry.name);

          // Create a relative path without the leading slash for GitHub
          const relativePath = basePath ? `${basePath}/${entry.name}` : entry.name;

          // Skip node_modules, .git directories and other common excludes
          if (
            entry.isDirectory() &&
            (entry.name === 'node_modules' ||
              entry.name === '.git' ||
              entry.name === 'dist' ||
              entry.name === 'build' ||
              entry.name === '.cache' ||
              entry.name === '.next')
          ) {
            continue;
          }

          if (entry.isFile()) {
            // Never publish local noise or secrets.
            if (entry.name.endsWith('.DS_Store') || entry.name.endsWith('.log') || entry.name.startsWith('.env')) {
              continue;
            }

            try {
              /**
               * Read bytes, and base64 binaries. Reading with 'utf-8' replaced every invalid
               * byte with U+FFFD, so images/models/fonts were pushed to the user's repo as
               * corrupted text (the comment above used to claim binaries were "skipped" —
               * they never were).
               */
              const bytes = await container.fs.readFile(fullPath);

              files[relativePath] = isBinaryPath(fullPath)
                ? { content: bytesToBase64(bytes), encoding: 'base64' }
                : { content: new TextDecoder().decode(bytes), encoding: 'utf8' };
            } catch (error) {
              console.warn(`Could not read file ${fullPath}:`, error);
              continue;
            }
          } else if (entry.isDirectory()) {
            const subFiles = await getAllFiles(fullPath, relativePath);
            Object.assign(files, subFiles);
          }
        }

        return files;
      }

      const fileContents = await getAllFiles('/');

      /*
       * Show GitHub deployment dialog here - it will handle the actual deployment
       * and will receive these files to deploy
       */

      /*
       * For now, we'll just complete the deployment with a success message
       * Notify that deployment preparation is complete
       */
      deployArtifact.runner.handleDeployAction('deploying', 'complete', {
        source: 'github',
      });

      // Show success toast notification
      toast.success(`🚀 GitHub deployment preparation completed successfully!`);

      return {
        success: true,
        files: fileContents,
        projectName: artifact.title || `${brand.productSlug}-project`,
      };
    } catch (err) {
      console.error('GitHub deploy error:', err);
      toast.error(err instanceof Error ? err.message : 'GitHub deployment preparation failed');

      return false;
    } finally {
      setIsDeploying(false);
    }
  };

  return {
    isDeploying,
    handleGitHubDeploy,
    isConnected: !!getLocalStorage('github_connection')?.user,
  };
}
