/**
 * Is this USER connected to a git provider through the platform's own OAuth (§4.5.4b)?
 *
 * The repo pickers already ask `useGitHubConnection` / `useGitLabConnection`, but those answer a
 * different question: *"does this BROWSER hold a git token?"* — which under §4.5.4b is permanently
 * no, by design ("the client never holds or sends a git token", pinned by `no-client-token.spec.ts`).
 * The platform's connection lives in an encrypted `git_tokens` row and is only visible through
 * `/api/git/connections`, which returns the provider and display login and never a token (§5).
 *
 * Without this the connect button was unfalsifiably broken: pressing it ran a real OAuth round-trip,
 * GitHub auto-approved, the token landed server-side, and the picker re-rendered the same
 * "connect first" message — so the only observable effect of a successful connection was a flicker.
 *
 * ⚠️ `connected` starts **false while loading** and the caller must distinguish the two. Rendering
 * the connect prompt during the fetch makes a connected user see "not connected" for a moment and
 * press a button they did not need — the same wrong-then-right flash the sidebar identity was fixed
 * for. `isLoading` exists so the empty state can wait a beat instead of guessing.
 */
import { useCallback, useEffect, useState } from 'react';

export type PlatformGitProvider = 'github' | 'gitlab';

interface ConnectionSummary {
  provider: PlatformGitProvider;
  providerLogin?: string;
  connectedAt?: string;
}

export interface PlatformGitConnection {
  /** The server holds an OAuth token for this user and provider. */
  connected: boolean;

  /** The account name to show — never a token. */
  login?: string;

  /** The operator configured this provider at all (so "connect" can even work). */
  configured: boolean;

  isLoading: boolean;

  /** Re-read after returning from OAuth. */
  refresh: () => void;
}

export function usePlatformGitConnection(provider: PlatformGitProvider): PlatformGitConnection {
  const [state, setState] = useState<Omit<PlatformGitConnection, 'refresh'>>({
    connected: false,
    configured: false,
    isLoading: true,
  });

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/git/connections');

      if (!response.ok) {
        setState({ connected: false, configured: false, isLoading: false });
        return;
      }

      const data = (await response.json()) as {
        configured?: PlatformGitProvider[];
        connections?: ConnectionSummary[];
      };

      const match = (data.connections ?? []).find((c) => c.provider === provider);

      setState({
        connected: Boolean(match),
        login: match?.providerLogin,
        configured: (data.configured ?? []).includes(provider),
        isLoading: false,
      });
    } catch {
      /*
       * A failed read is "we could not ask", not "not connected" — but the only thing this drives is
       * whether to offer a connect button, and offering one to somebody already connected costs a
       * redundant round-trip through a provider that will wave them straight through. Reporting
       * connected on a network error, by contrast, renders a picker that can only fail.
       */
      setState({ connected: false, configured: false, isLoading: false });
    }
  }, [provider]);

  useEffect(() => {
    load();
  }, [load]);

  return { ...state, refresh: load };
}
