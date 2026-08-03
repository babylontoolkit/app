import React, { useState, useEffect, useMemo } from 'react';
import { motion } from 'framer-motion';
import { Button } from '~/components/ui/Button';
import { BranchSelector } from '~/components/ui/BranchSelector';
import { GitHubRepositoryCard } from './GitHubRepositoryCard';
import type { GitHubRepoInfo } from '~/types/GitHub';
import { useGitHubConnection, useGitHubStats, usePlatformGitConnection } from '~/lib/hooks';
import { startGitConnect } from '~/lib/persistence';
import { classNames } from '~/utils/classNames';
import { Search, RefreshCw, GitBranch, Calendar, Filter } from 'lucide-react';

interface GitHubRepositorySelectorProps {
  onClone?: (repoUrl: string, branch?: string) => void;
  className?: string;
}

type SortOption = 'updated' | 'stars' | 'name' | 'created';
type FilterOption = 'all' | 'own' | 'forks' | 'archived';

export function GitHubRepositorySelector({ onClone, className }: GitHubRepositorySelectorProps) {
  const { connection, isConnected } = useGitHubConnection();

  /*
   * 🔴 TWO CONNECTIONS, AND ONLY ONE OF THEM IS THE PLATFORM'S.
   *
   * `useGitHubConnection` answers "does this BROWSER hold a GitHub token?" — upstream bolt.diy's
   * BYOK model. Under §4.5.4b the answer is permanently NO: the platform's OAuth writes an
   * encrypted `git_tokens` row and the client never sees a token. So this picker gated on a fact
   * that a successful connection could not change, and pressing Connect ran a real OAuth
   * round-trip, succeeded, and returned to the identical "connect first" screen.
   *
   * Either connection is sufficient, and they are NOT interchangeable below: a browser token drives
   * the client-side API service, a platform connection drives the server-side route (which now
   * resolves the caller's stored token — see `callerOAuthToken`).
   */
  const platform = usePlatformGitConnection('github');
  const hasAnyConnection = isConnected || platform.connected;

  /*
   * `useGitHubStats` dereferences `connection` and its auto-fetch effect skips a null one, so a
   * platform-only user needs a stand-in. It carries NO token — that is what routes the fetch
   * server-side — and a `login` purely so the client-side branch, if ever taken, has a name rather
   * than `undefined`.
   */
  const statsConnection = connection?.token
    ? connection
    : platform.connected
      ? ({ ...(connection ?? {}), user: { login: platform.login ?? '' } } as typeof connection)
      : connection;

  const {
    stats,
    isLoading: isStatsLoading,
    refreshStats,
  } = useGitHubStats(
    statsConnection,
    {
      autoFetch: true,
      cacheTimeout: 30 * 60 * 1000, // 30 minutes

      /*
       * 🔴 A picker needs NAMES, not statistics. Without this the dialog crawled every repository on
       * the account for branch/contributor/issue/PR counts it does not render — 563 repos ≈ 2,800
       * GitHub calls — and simply never finished. See UseGitHubStatsOptions.reposOnly.
       */
      reposOnly: true,
    },

    /*
     * The third argument was OMITTED here while both sibling call sites (GitHubTab, GitHubStats) pass
     * it. It selects the server-side route for a connection whose token lives on the server rather
     * than in this browser — without it such a connection can never load anything at all, silently,
     * because the client-side branch has no token to use.
     */
    !connection?.token,
  );

  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState<SortOption>('updated');
  const [filterBy, setFilterBy] = useState<FilterOption>('all');
  const [currentPage, setCurrentPage] = useState(1);
  const [selectedRepo, setSelectedRepo] = useState<GitHubRepoInfo | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isBranchSelectorOpen, setIsBranchSelectorOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const repositories = stats?.repos || [];
  const REPOS_PER_PAGE = 12;

  // Filter and search repositories
  const filteredRepositories = useMemo(() => {
    if (!repositories) {
      return [];
    }

    const filtered = repositories.filter((repo: GitHubRepoInfo) => {
      // Search filter
      const matchesSearch =
        !searchQuery ||
        repo.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        repo.description?.toLowerCase().includes(searchQuery.toLowerCase()) ||
        repo.full_name.toLowerCase().includes(searchQuery.toLowerCase());

      // Type filter
      let matchesFilter = true;

      switch (filterBy) {
        case 'own':
          matchesFilter = !repo.fork;
          break;
        case 'forks':
          matchesFilter = repo.fork === true;
          break;
        case 'archived':
          matchesFilter = repo.archived === true;
          break;
        case 'all':
        default:
          matchesFilter = true;
          break;
      }

      return matchesSearch && matchesFilter;
    });

    // Sort repositories
    filtered.sort((a: GitHubRepoInfo, b: GitHubRepoInfo) => {
      switch (sortBy) {
        case 'name':
          return a.name.localeCompare(b.name);
        case 'stars':
          return b.stargazers_count - a.stargazers_count;
        case 'created':
          return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(); // Using updated_at as proxy
        case 'updated':
        default:
          return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
      }
    });

    return filtered;
  }, [repositories, searchQuery, sortBy, filterBy]);

  // Pagination
  const totalPages = Math.ceil(filteredRepositories.length / REPOS_PER_PAGE);
  const startIndex = (currentPage - 1) * REPOS_PER_PAGE;
  const currentRepositories = filteredRepositories.slice(startIndex, startIndex + REPOS_PER_PAGE);

  const handleRefresh = async () => {
    setIsRefreshing(true);
    setError(null);

    try {
      await refreshStats();
    } catch (err) {
      console.error('Failed to refresh GitHub repositories:', err);
      setError(err instanceof Error ? err.message : 'Failed to refresh repositories');
    } finally {
      setIsRefreshing(false);
    }
  };

  const handleCloneRepository = (repo: GitHubRepoInfo) => {
    setSelectedRepo(repo);
    setIsBranchSelectorOpen(true);
  };

  const handleBranchSelect = (branch: string) => {
    if (onClone && selectedRepo) {
      const cloneUrl = selectedRepo.html_url + '.git';
      onClone(cloneUrl, branch);
    }

    setSelectedRepo(null);
  };

  const handleCloseBranchSelector = () => {
    setIsBranchSelectorOpen(false);
    setSelectedRepo(null);
  };

  // Reset to first page when filters change
  useEffect(() => {
    setCurrentPage(1);
  }, [searchQuery, sortBy, filterBy]);

  /*
   * Wait rather than guess. `platform.connected` is false while `/api/git/connections` is in flight,
   * so rendering the prompt immediately shows a connected user "not connected" and invites them to
   * press a button they do not need — the wrong-then-right flash the sidebar identity was fixed for.
   */
  if (platform.isLoading && !hasAnyConnection) {
    return (
      <div className="flex flex-col items-center justify-center p-8 space-y-4">
        <div className="animate-spin w-8 h-8 border-2 border-bolt-elements-borderColorActive border-t-transparent rounded-full" />
        <p className="text-sm text-bolt-elements-textSecondary">Checking your GitHub connection…</p>
      </div>
    );
  }

  if (!hasAnyConnection) {
    /*
     * 🔴 This button used to be `window.location.reload()` labelled "Refresh Connection" — a dead
     * end wearing an action's clothes. Told "connect to GitHub first", the user presses the only
     * control on screen, the page reloads, and they are looking at the same sentence again with no
     * idea what they did wrong. Reloading cannot create a connection; only OAuth can.
     *
     * So it says what it does and does what it says: the same `startGitConnect` every other
     * connect affordance uses (the git chip, the divergence dialog), which returns here afterwards.
     * §4.1a's rule about permanently-disabled menu rows is the same rule — a control that cannot
     * reach its stated outcome is worse than no control, because the user blames themselves.
     */
    return (
      <div className="text-center p-8">
        <p className="text-bolt-elements-textSecondary mb-4">Connect your GitHub account to browse your repositories</p>
        <Button variant="outline" onClick={() => startGitConnect('github')}>
          Connect to GitHub
        </Button>
      </div>
    );
  }

  if (isStatsLoading && !stats) {
    return (
      <div className="flex flex-col items-center justify-center p-8 space-y-4">
        <div className="animate-spin w-8 h-8 border-2 border-bolt-elements-borderColorActive border-t-transparent rounded-full" />
        <p className="text-sm text-bolt-elements-textSecondary">Loading repositories...</p>
      </div>
    );
  }

  if (!repositories.length) {
    return (
      <div className="text-center p-8">
        <GitBranch className="w-12 h-12 text-bolt-elements-textTertiary mx-auto mb-4" />
        <p className="text-bolt-elements-textSecondary mb-4">No repositories found</p>
        <Button variant="outline" onClick={handleRefresh} disabled={isRefreshing}>
          <RefreshCw className={classNames('w-4 h-4 mr-2', { 'animate-spin': isRefreshing })} />
          Refresh
        </Button>
      </div>
    );
  }

  return (
    <motion.div
      className={classNames('space-y-6', className)}
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
    >
      {/* Header with stats */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold text-bolt-elements-textPrimary">Select Repository to Clone</h3>
          <p className="text-sm text-bolt-elements-textSecondary">
            {filteredRepositories.length} of {repositories.length} repositories
          </p>
        </div>
        <Button
          onClick={handleRefresh}
          disabled={isRefreshing}
          variant="outline"
          size="sm"
          className="flex items-center gap-2"
        >
          <RefreshCw className={classNames('w-4 h-4', { 'animate-spin': isRefreshing })} />
          Refresh
        </Button>
      </div>

      {error && repositories.length > 0 && (
        <div className="p-3 rounded-lg bg-yellow-50 border border-yellow-200 dark:bg-yellow-900/20 dark:border-yellow-700">
          <p className="text-sm text-yellow-800 dark:text-yellow-200">Warning: {error}. Showing cached data.</p>
        </div>
      )}

      {/* Search and Filters */}
      <div className="flex flex-col sm:flex-row gap-4">
        {/* Search */}
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-bolt-elements-textTertiary" />
          <input
            type="text"
            placeholder="Search repositories..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-10 pr-4 py-2 rounded-lg bg-bolt-elements-background-depth-1 border border-bolt-elements-borderColor text-bolt-elements-textPrimary placeholder-bolt-elements-textTertiary focus:outline-none focus:ring-1 focus:ring-bolt-elements-borderColorActive"
          />
        </div>

        {/* Sort */}
        <div className="flex items-center gap-2">
          <Calendar className="w-4 h-4 text-bolt-elements-textTertiary" />
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as SortOption)}
            className="px-3 py-2 rounded-lg bg-bolt-elements-background-depth-1 border border-bolt-elements-borderColor text-bolt-elements-textPrimary text-sm focus:outline-none focus:ring-1 focus:ring-bolt-elements-borderColorActive"
          >
            <option value="updated">Recently updated</option>
            <option value="stars">Most starred</option>
            <option value="name">Name (A-Z)</option>
            <option value="created">Recently created</option>
          </select>
        </div>

        {/* Filter */}
        <div className="flex items-center gap-2">
          <Filter className="w-4 h-4 text-bolt-elements-textTertiary" />
          <select
            value={filterBy}
            onChange={(e) => setFilterBy(e.target.value as FilterOption)}
            className="px-3 py-2 rounded-lg bg-bolt-elements-background-depth-1 border border-bolt-elements-borderColor text-bolt-elements-textPrimary text-sm focus:outline-none focus:ring-1 focus:ring-bolt-elements-borderColorActive"
          >
            <option value="all">All repositories</option>
            <option value="own">Own repositories</option>
            <option value="forks">Forked repositories</option>
            <option value="archived">Archived repositories</option>
          </select>
        </div>
      </div>

      {/* Repository Grid */}
      {currentRepositories.length > 0 ? (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {currentRepositories.map((repo) => (
              <GitHubRepositoryCard key={repo.id} repo={repo} onClone={() => handleCloneRepository(repo)} />
            ))}
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between pt-4 border-t border-bolt-elements-borderColor">
              <div className="text-sm text-bolt-elements-textSecondary">
                Showing {Math.min(startIndex + 1, filteredRepositories.length)} to{' '}
                {Math.min(startIndex + REPOS_PER_PAGE, filteredRepositories.length)} of {filteredRepositories.length}{' '}
                repositories
              </div>
              <div className="flex items-center gap-2">
                <Button
                  onClick={() => setCurrentPage((prev) => Math.max(1, prev - 1))}
                  disabled={currentPage === 1}
                  variant="outline"
                  size="sm"
                >
                  Previous
                </Button>
                <span className="text-sm text-bolt-elements-textSecondary px-3">
                  {currentPage} of {totalPages}
                </span>
                <Button
                  onClick={() => setCurrentPage((prev) => Math.min(totalPages, prev + 1))}
                  disabled={currentPage === totalPages}
                  variant="outline"
                  size="sm"
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </>
      ) : (
        <div className="text-center py-8">
          <p className="text-bolt-elements-textSecondary">No repositories found matching your search criteria.</p>
        </div>
      )}

      {/* Branch Selector Modal */}
      {selectedRepo && (
        <BranchSelector
          provider="github"
          repoOwner={selectedRepo.full_name.split('/')[0]}
          repoName={selectedRepo.full_name.split('/')[1]}
          token={connection?.token || ''}
          defaultBranch={selectedRepo.default_branch}
          onBranchSelect={handleBranchSelect}
          onClose={handleCloseBranchSelector}
          isOpen={isBranchSelectorOpen}
        />
      )}
    </motion.div>
  );
}
