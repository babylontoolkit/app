import { useState, useMemo, useCallback, useEffect } from 'react';
import { workbenchStore } from '~/lib/stores/workbench';
import { sandbox } from '~/lib/sandbox';
import type { SandboxProvider, SandboxTextSearchOptions, SandboxTextSearchProgress } from '~/lib/sandbox';
import { WORK_DIR } from '~/utils/constants';
import { debounce } from '~/utils/debounce';

interface DisplayMatch {
  path: string;
  lineNumber: number;
  previewText: string;
  matchCharStart: number;
  matchCharEnd: number;
}

async function performTextSearch(
  instance: SandboxProvider,
  query: string,
  options: Omit<SandboxTextSearchOptions, 'folders'>,
  onProgress: (results: DisplayMatch[]) => void,
): Promise<void> {
  /*
   * Search is an OPTIONAL sandbox capability (`spec/sandbox-seam.md`): a server-container provider
   * may have no ripgrep-class index to offer. Read the declared flag rather than probing for the
   * method — a `typeof x.internal?.textSearch === 'function'` check (what this used to do) reads as
   * defensive coding, cannot be tested, and silently returns "no results" instead of "not supported".
   */
  if (!instance?.capabilities.textSearch || !instance.textSearch) {
    console.error('The active sandbox does not support project-wide text search.');

    return;
  }

  const searchOptions: SandboxTextSearchOptions = {
    ...options,
    folders: [WORK_DIR],
  };

  const progressCallback: SandboxTextSearchProgress = (filePath: any, apiMatches: any[]) => {
    const displayMatches: DisplayMatch[] = [];

    apiMatches.forEach((apiMatch: { preview: { text: string; matches: string | any[] }; ranges: any[] }) => {
      const previewLines = apiMatch.preview.text.split('\n');

      apiMatch.ranges.forEach((range: { startLineNumber: number; startColumn: any; endColumn: any }) => {
        let previewLineText = '(Preview line not found)';
        let lineIndexInPreview = -1;

        if (apiMatch.preview.matches.length > 0) {
          const previewStartLine = apiMatch.preview.matches[0].startLineNumber;
          lineIndexInPreview = range.startLineNumber - previewStartLine;
        }

        if (lineIndexInPreview >= 0 && lineIndexInPreview < previewLines.length) {
          previewLineText = previewLines[lineIndexInPreview];
        } else {
          previewLineText = previewLines[0] ?? '(Preview unavailable)';
        }

        displayMatches.push({
          path: filePath,
          lineNumber: range.startLineNumber,
          previewText: previewLineText,
          matchCharStart: range.startColumn,
          matchCharEnd: range.endColumn,
        });
      });
    });

    if (displayMatches.length > 0) {
      onProgress(displayMatches);
    }
  };

  try {
    await instance.textSearch(query, searchOptions, progressCallback);
  } catch (error) {
    console.error('Error during sandbox text search:', error);
  }
}

function groupResultsByFile(results: DisplayMatch[]): Record<string, DisplayMatch[]> {
  return results.reduce(
    (acc, result) => {
      if (!acc[result.path]) {
        acc[result.path] = [];
      }

      acc[result.path].push(result);

      return acc;
    },
    {} as Record<string, DisplayMatch[]>,
  );
}

export function Search() {
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<DisplayMatch[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [expandedFiles, setExpandedFiles] = useState<Record<string, boolean>>({});
  const [hasSearched, setHasSearched] = useState(false);

  /**
   * Whether this workspace's runtime can search at all.
   *
   * `undefined` while the sandbox is still connecting — a THIRD state, not a default: rendering
   * "not available" during the boot of a provider that supports search would be wrong for a second
   * on every load, and rendering "available" and then disabling the input under the user's cursor is
   * worse. Nothing is claimed until the provider answers.
   */
  const [textSearchSupported, setTextSearchSupported] = useState<boolean | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;

    void sandbox
      .then((instance) => {
        if (!cancelled) {
          setTextSearchSupported(Boolean(instance?.capabilities.textSearch && instance.textSearch));
        }
      })
      .catch(() => {
        /*
         * A sandbox that failed to boot is not a sandbox that cannot search — the boot failure has
         * its own loud surface (`onSandboxFailure`). Staying `undefined` keeps this panel from
         * inventing a second, wrong explanation for it.
         */
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const groupedResults = useMemo(() => groupResultsByFile(searchResults), [searchResults]);

  useEffect(() => {
    if (searchResults.length > 0) {
      const allExpanded: Record<string, boolean> = {};
      Object.keys(groupedResults).forEach((file) => {
        allExpanded[file] = true;
      });
      setExpandedFiles(allExpanded);
    }
  }, [groupedResults, searchResults]);

  const handleSearch = useCallback(async (query: string) => {
    if (!query.trim()) {
      setSearchResults([]);
      setIsSearching(false);
      setExpandedFiles({});
      setHasSearched(false);

      return;
    }

    setIsSearching(true);
    setSearchResults([]);
    setExpandedFiles({});
    setHasSearched(true);

    const minLoaderTime = 300; // ms
    const start = Date.now();

    try {
      const instance = await sandbox;
      const options: Omit<SandboxTextSearchOptions, 'folders'> = {
        homeDir: WORK_DIR, // Adjust this path as needed
        includes: ['**/*.*'],
        excludes: [
          '**/node_modules/**',
          '**/package-lock.json',
          '**/.git/**',

          // The sandbox provider's own directory — infrastructure, never the user's project.
          '**/.codesandbox/**',
          '**/dist/**',
          '**/*.lock',
        ],
        gitignore: true,
        requireGit: false,
        globalIgnoreFiles: true,
        ignoreSymlinks: false,
        resultLimit: 500,
        isRegex: false,
        caseSensitive: false,
        isWordMatch: false,
      };

      const progressHandler = (batchResults: DisplayMatch[]) => {
        setSearchResults((prevResults) => [...prevResults, ...batchResults]);
      };

      await performTextSearch(instance, query, options, progressHandler);
    } catch (error) {
      console.error('Failed to initiate search:', error);
    } finally {
      const elapsed = Date.now() - start;

      if (elapsed < minLoaderTime) {
        setTimeout(() => setIsSearching(false), minLoaderTime - elapsed);
      } else {
        setIsSearching(false);
      }
    }
  }, []);

  const debouncedSearch = useCallback(debounce(handleSearch, 300), [handleSearch]);

  useEffect(() => {
    // Never dispatch a search the runtime cannot answer — the panel above says so instead.
    if (textSearchSupported === false) {
      return;
    }

    debouncedSearch(searchQuery);
  }, [searchQuery, debouncedSearch, textSearchSupported]);

  const handleResultClick = (filePath: string, line?: number) => {
    workbenchStore.setSelectedFile(filePath);

    /*
     * Adjust line number to be 0-based if it's defined
     * The search results use 1-based line numbers, but CodeMirrorEditor expects 0-based
     */
    const adjustedLine = typeof line === 'number' ? Math.max(0, line - 1) : undefined;

    workbenchStore.setCurrentDocumentScrollPosition({ line: adjustedLine, column: 0 });
  };

  return (
    <div className="flex flex-col h-full bg-bolt-elements-background-depth-2">
      {/* Search Bar */}
      <div className="flex items-center py-3 px-3">
        <div className="relative flex-1">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={textSearchSupported === false ? 'Search unavailable' : 'Search'}
            disabled={textSearchSupported === false}
            className="w-full px-2 py-1 rounded-md bg-bolt-elements-background-depth-3 text-bolt-elements-textPrimary placeholder-bolt-elements-textTertiary focus:outline-none transition-all disabled:opacity-50 disabled:cursor-not-allowed"
          />
        </div>
      </div>

      {/* Results */}
      <div className="flex-1 overflow-auto py-2">
        {/*
         * 🔴 "Not supported" is not "no results". The tab used to run the search, hit the capability
         * check, log to the console and fall through to the ordinary empty state — so a user on a
         * runtime without a text index was told, in the product's own words, that their code does not
         * contain what they just searched for. The tab stays VISIBLE: a limitation the user can read
         * beats one they have to discover by being misled.
         */}
        {textSearchSupported === false && (
          <div className="flex flex-col items-center justify-center gap-2 h-40 px-6 text-center">
            <div className="i-ph:magnifying-glass-minus w-6 h-6 text-bolt-elements-textTertiary" />
            <div className="text-sm text-bolt-elements-textSecondary">
              Text search isn&apos;t available on this workspace runtime yet
            </div>
            <div className="text-xs text-bolt-elements-textTertiary">
              Open a file from the tree and use the editor&apos;s own find instead.
            </div>
          </div>
        )}
        {textSearchSupported !== false && isSearching && (
          <div className="flex items-center justify-center h-32 text-bolt-elements-textTertiary">
            <div className="i-ph:circle-notch animate-spin mr-2" /> Searching...
          </div>
        )}
        {textSearchSupported !== false &&
          !isSearching &&
          hasSearched &&
          searchResults.length === 0 &&
          searchQuery.trim() !== '' && (
            <div className="flex items-center justify-center h-32 text-gray-500">No results found.</div>
          )}
        {!isSearching &&
          Object.keys(groupedResults).map((file) => (
            <div key={file} className="mb-2">
              <button
                className="flex gap-2 items-center w-full text-left py-1 px-2 text-bolt-elements-textSecondary bg-transparent hover:bg-bolt-elements-background-depth-3 group"
                onClick={() => setExpandedFiles((prev) => ({ ...prev, [file]: !prev[file] }))}
              >
                <span
                  className=" i-ph:caret-down-thin w-3 h-3 text-bolt-elements-textSecondary transition-transform"
                  style={{ transform: expandedFiles[file] ? 'rotate(180deg)' : undefined }}
                />
                <span className="font-normal text-sm">{file.split('/').pop()}</span>
                <span className="h-5.5 w-5.5 flex items-center justify-center text-xs ml-auto bg-bolt-elements-item-backgroundAccent text-bolt-elements-item-contentAccent rounded-full">
                  {groupedResults[file].length}
                </span>
              </button>
              {expandedFiles[file] && (
                <div className="">
                  {groupedResults[file].map((match, idx) => {
                    const contextChars = 7;
                    const isStart = match.matchCharStart <= contextChars;
                    const previewStart = isStart ? 0 : match.matchCharStart - contextChars;
                    const previewText = match.previewText.slice(previewStart);
                    const matchStart = isStart ? match.matchCharStart : contextChars;
                    const matchEnd = isStart
                      ? match.matchCharEnd
                      : contextChars + (match.matchCharEnd - match.matchCharStart);

                    return (
                      <div
                        key={idx}
                        className="hover:bg-bolt-elements-background-depth-3 cursor-pointer transition-colors pl-6 py-1"
                        onClick={() => handleResultClick(match.path, match.lineNumber)}
                      >
                        <pre className="font-mono text-xs text-bolt-elements-textTertiary truncate">
                          {!isStart && <span>...</span>}
                          {previewText.slice(0, matchStart)}
                          <span className="bg-bolt-elements-item-backgroundAccent text-bolt-elements-item-contentAccent rounded px-1">
                            {previewText.slice(matchStart, matchEnd)}
                          </span>
                          {previewText.slice(matchEnd)}
                        </pre>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ))}
      </div>
    </div>
  );
}
