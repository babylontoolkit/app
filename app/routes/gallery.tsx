/**
 * `/gallery` — the public showcase of shared games (SPEC §4.8).
 *
 * The zero-cost "take a peek" funnel: a grid of admin-approved games anyone can play (free to us — the
 * builds are static on the CDN) and, with a sign-up, remix. The loader reads the same gallery
 * projection the API uses (approved-only, public fields only), so the page and the API can never
 * disagree about what is public.
 */
import { json, type LoaderFunctionArgs, type MetaFunction } from '@remix-run/cloudflare';
import { useLoaderData } from '@remix-run/react';
import { Header } from '~/components/header/Header';
import BackgroundRays from '~/components/ui/BackgroundRays';
import { getProjectStore } from '~/lib/.server/projects/store';
import { listGallery } from '~/lib/.server/share/gallery';

export const meta: MetaFunction = () => [
  { title: 'Gallery' },
  { name: 'description', content: 'Play and remix games made with Babylon Toolkit.' },
];

export async function loader({ context }: LoaderFunctionArgs) {
  const games = await listGallery(getProjectStore(context), 48, context);
  return json({ games });
}

export default function Gallery() {
  const { games } = useLoaderData<typeof loader>();

  return (
    <div className="flex flex-col h-full w-full bg-bolt-elements-background-depth-1 overflow-auto">
      <BackgroundRays />
      <Header />
      <main className="flex-1 w-full max-w-6xl mx-auto px-6 py-10">
        <h1 className="text-2xl font-semibold text-bolt-elements-textPrimary">Gallery</h1>
        <p className="text-bolt-elements-textSecondary mt-1">
          Games made with Babylon Toolkit. Play any of them — or remix one into your own.
        </p>

        {games.length === 0 ? (
          <div className="mt-16 text-center text-bolt-elements-textSecondary">
            No games featured yet. Be the first — build one and submit it to the gallery.
          </div>
        ) : (
          <div className="mt-8 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {games.map((game) => (
              <div
                key={game.shareId}
                className="rounded-xl border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 overflow-hidden flex flex-col"
              >
                <div className="p-4 flex-1">
                  <h2 className="text-lg font-medium text-bolt-elements-textPrimary truncate">{game.title}</h2>
                  {game.description && (
                    <p className="text-sm text-bolt-elements-textSecondary mt-1 line-clamp-2">{game.description}</p>
                  )}
                </div>
                <div className="flex border-t border-bolt-elements-borderColor">
                  <a
                    href={game.url}
                    target="_blank"
                    rel="noreferrer"
                    className="flex-1 text-center py-2.5 text-sm font-medium text-white bg-accent-500 hover:bg-bolt-elements-button-primary-backgroundHover flex items-center justify-center gap-1.5"
                  >
                    <span className="i-ph:play" /> Play
                  </a>
                  <a
                    href={`/remix/${game.shareId}`}
                    className="flex-1 text-center py-2.5 text-sm font-medium text-bolt-elements-textPrimary hover:bg-bolt-elements-background-depth-3 flex items-center justify-center gap-1.5 border-l border-bolt-elements-borderColor"
                  >
                    <span className="i-ph:git-fork" /> Remix
                  </a>
                </div>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
