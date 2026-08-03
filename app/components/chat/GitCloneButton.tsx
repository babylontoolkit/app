import { importRepositoryIntoWorkspace, type ImportChat } from '~/lib/git/import-repository';
import { useState } from 'react';
import { toast } from 'react-toastify';

import { classNames } from '~/utils/classNames';
import { Button } from '~/components/ui/Button';
import { X, Github, GitBranch } from 'lucide-react';

// Import the new repository selector components
import { GitHubRepositorySelector } from '~/components/@settings/tabs/github/components/GitHubRepositorySelector';
import { GitLabRepositorySelector } from '~/components/@settings/tabs/gitlab/components/GitLabRepositorySelector';

interface GitCloneButtonProps {
  className?: string;
  importChat?: ImportChat;
}

export default function GitCloneButton({ importChat, className }: GitCloneButtonProps) {
  const [loading, setLoading] = useState(false);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [selectedProvider, setSelectedProvider] = useState<'github' | 'gitlab' | null>(null);

  /**
   * Both selectors have ALWAYS passed the branch the user chose, and this handler used to drop it.
   *
   * `GitHubRepositorySelector` and `GitLabRepositorySelector` each open a branch picker before calling
   * back, so picking `develop` and getting `main` was a silent wrong answer with a UI that had already
   * asked the right question. It is forwarded now — no UI change was needed, only a second parameter.
   */
  const handleClone = async (repoUrl: string, branch?: string) => {
    setLoading(true);
    setIsDialogOpen(false);
    setSelectedProvider(null);

    /*
     * Still the provider the user picked, despite the `setSelectedProvider(null)` two lines up.
     *
     * ⚠️ The reason is CLOSURE CAPTURE, not batching: `selectedProvider` is a `const` binding in this
     * render's scope, and a state setter cannot reassign it — the next render gets a new binding, this
     * one keeps what it was called with, batched or not. (Said "React batches them" in its first
     * draft, which is true of React and irrelevant here; the rule holds for a different reason than
     * the one written down, which is how a comment stops protecting the code it describes.)
     *
     * It matters because both selectors are only rendered while `selectedProvider` is set, so this can
     * never legitimately be `null` — and a GitLab import that silently defaulted to GitHub would
     * resolve the wrong token against the wrong host.
     */
    const provider = selectedProvider ?? undefined;

    try {
      if (!importChat) {
        return;
      }

      /*
       * Everything — the boot surface, the server clone, the byte-faithful write, the settle and the
       * hand-off — lives in one module shared with the `/git?url=` door (`import-repository.ts`). It
       * returns an outcome and never throws; the `catch` below is for a genuine programming error.
       */
      const result = await importRepositoryIntoWorkspace({ repo: repoUrl, branch, provider, importChat });

      if (!result.ok) {
        /*
         * The server's own words — "connect GitHub and try again", "over the 256MB import limit",
         * "that repository stores 12 file(s) in Git-LFS". A fixed "Failed to import repository" is
         * indistinguishable from a button that did nothing, and each of those names a different action.
         */
        toast.error(result.message ?? 'The repository could not be imported.');
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <Button
        onClick={() => {
          setSelectedProvider(null);
          setIsDialogOpen(true);
        }}
        title="Clone a repo"
        variant="default"
        size="lg"
        className={classNames(
          'gap-2 bg-bolt-elements-background-depth-1',
          'text-bolt-elements-textPrimary',
          'hover:bg-bolt-elements-background-depth-2',
          'border border-bolt-elements-borderColor',
          'h-10 px-4 py-2 min-w-[120px] justify-center',
          'transition-all duration-200 ease-in-out',
          className,
        )}
        disabled={loading}
      >
        Clone a repo
        <div className="flex items-center gap-1 ml-2">
          <Github className="w-4 h-4" />
          <GitBranch className="w-4 h-4" />
        </div>
      </Button>

      {/* Provider Selection Dialog */}
      {isDialogOpen && !selectedProvider && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white dark:bg-gray-950 rounded-xl shadow-xl border border-bolt-elements-borderColor dark:border-bolt-elements-borderColor max-w-md w-full">
            <div className="p-6">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-semibold text-bolt-elements-textPrimary dark:text-bolt-elements-textPrimary">
                  Choose Repository Provider
                </h3>
                <button
                  onClick={() => setIsDialogOpen(false)}
                  className="p-2 rounded-lg bg-transparent hover:bg-bolt-elements-background-depth-1 dark:hover:bg-bolt-elements-background-depth-1 text-bolt-elements-textSecondary dark:text-bolt-elements-textSecondary hover:text-bolt-elements-textPrimary dark:hover:text-bolt-elements-textPrimary transition-all duration-200 hover:scale-105 active:scale-95"
                >
                  <X className="w-5 h-5 transition-transform duration-200 hover:rotate-90" />
                </button>
              </div>

              <div className="space-y-3">
                <button
                  onClick={() => setSelectedProvider('github')}
                  className="w-full p-4 rounded-lg bg-bolt-elements-background-depth-1 dark:bg-bolt-elements-background-depth-1 hover:bg-bolt-elements-background-depth-2 dark:hover:bg-bolt-elements-background-depth-2 border border-bolt-elements-borderColor dark:border-bolt-elements-borderColor hover:border-bolt-elements-borderColorActive dark:hover:border-bolt-elements-borderColorActive transition-all duration-200 text-left group"
                >
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-lg bg-blue-500/10 dark:bg-blue-500/20 flex items-center justify-center group-hover:bg-blue-500/20 dark:group-hover:bg-blue-500/30 transition-colors">
                      <Github className="w-6 h-6 text-blue-600 dark:text-blue-400" />
                    </div>
                    <div>
                      <div className="font-medium text-bolt-elements-textPrimary dark:text-bolt-elements-textPrimary">
                        GitHub
                      </div>
                      <div className="text-sm text-bolt-elements-textSecondary dark:text-bolt-elements-textSecondary">
                        Clone from GitHub repositories
                      </div>
                    </div>
                  </div>
                </button>

                <button
                  onClick={() => setSelectedProvider('gitlab')}
                  className="w-full p-4 rounded-lg bg-bolt-elements-background-depth-1 dark:bg-bolt-elements-background-depth-1 hover:bg-bolt-elements-background-depth-2 dark:hover:bg-bolt-elements-background-depth-2 border border-bolt-elements-borderColor dark:border-bolt-elements-borderColor hover:border-bolt-elements-borderColorActive dark:hover:border-bolt-elements-borderColorActive transition-all duration-200 text-left group"
                >
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-lg bg-orange-500/10 dark:bg-orange-500/20 flex items-center justify-center group-hover:bg-orange-500/20 dark:group-hover:bg-orange-500/30 transition-colors">
                      <GitBranch className="w-6 h-6 text-orange-600 dark:text-orange-400" />
                    </div>
                    <div>
                      <div className="font-medium text-bolt-elements-textPrimary dark:text-bolt-elements-textPrimary">
                        GitLab
                      </div>
                      <div className="text-sm text-bolt-elements-textSecondary dark:text-bolt-elements-textSecondary">
                        Clone from GitLab repositories
                      </div>
                    </div>
                  </div>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* GitHub Repository Selection */}
      {isDialogOpen && selectedProvider === 'github' && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white dark:bg-gray-950 rounded-xl shadow-xl border border-bolt-elements-borderColor dark:border-bolt-elements-borderColor w-full max-w-4xl max-h-[90vh] overflow-hidden">
            <div className="p-6 border-b border-bolt-elements-borderColor dark:border-bolt-elements-borderColor flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-blue-500/10 dark:bg-blue-500/20 flex items-center justify-center">
                  <Github className="w-6 h-6 text-blue-600 dark:text-blue-400" />
                </div>
                <div>
                  <h3 className="text-lg font-semibold text-bolt-elements-textPrimary dark:text-bolt-elements-textPrimary">
                    Import GitHub Repository
                  </h3>
                  <p className="text-sm text-bolt-elements-textSecondary dark:text-bolt-elements-textSecondary">
                    Clone a repository from GitHub to your workspace
                  </p>
                </div>
              </div>
              <button
                onClick={() => {
                  setIsDialogOpen(false);
                  setSelectedProvider(null);
                }}
                className="p-2 rounded-lg bg-transparent hover:bg-bolt-elements-background-depth-1 dark:hover:bg-bolt-elements-background-depth-1 text-bolt-elements-textSecondary dark:text-bolt-elements-textSecondary hover:text-bolt-elements-textPrimary dark:hover:text-bolt-elements-textPrimary transition-all duration-200 hover:scale-105 active:scale-95"
              >
                <X className="w-5 h-5 transition-transform duration-200 hover:rotate-90" />
              </button>
            </div>

            <div className="p-6 max-h-[calc(90vh-140px)] overflow-y-auto">
              <GitHubRepositorySelector onClone={handleClone} />
            </div>
          </div>
        </div>
      )}

      {/* GitLab Repository Selection */}
      {isDialogOpen && selectedProvider === 'gitlab' && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white dark:bg-gray-950 rounded-xl shadow-xl border border-bolt-elements-borderColor dark:border-bolt-elements-borderColor w-full max-w-4xl max-h-[90vh] overflow-hidden">
            <div className="p-6 border-b border-bolt-elements-borderColor dark:border-bolt-elements-borderColor flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-orange-500/10 dark:bg-orange-500/20 flex items-center justify-center">
                  <GitBranch className="w-6 h-6 text-orange-600 dark:text-orange-400" />
                </div>
                <div>
                  <h3 className="text-lg font-semibold text-bolt-elements-textPrimary dark:text-bolt-elements-textPrimary">
                    Import GitLab Repository
                  </h3>
                  <p className="text-sm text-bolt-elements-textSecondary dark:text-bolt-elements-textSecondary">
                    Clone a repository from GitLab to your workspace
                  </p>
                </div>
              </div>
              <button
                onClick={() => {
                  setIsDialogOpen(false);
                  setSelectedProvider(null);
                }}
                className="p-2 rounded-lg bg-transparent hover:bg-bolt-elements-background-depth-1 dark:hover:bg-bolt-elements-background-depth-1 text-bolt-elements-textSecondary dark:text-bolt-elements-textSecondary hover:text-bolt-elements-textPrimary dark:hover:text-bolt-elements-textPrimary transition-all duration-200 hover:scale-105 active:scale-95"
              >
                <X className="w-5 h-5 transition-transform duration-200 hover:rotate-90" />
              </button>
            </div>

            <div className="p-6 max-h-[calc(90vh-140px)] overflow-y-auto">
              <GitLabRepositorySelector onClone={handleClone} />
            </div>
          </div>
        </div>
      )}
    </>
  );
}
