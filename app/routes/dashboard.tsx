/**
 * `/dashboard` — "All Projects" (SPEC §4.1 Dashboard).
 *
 * The one screen that shows a user their real project library. The sidebar lists *local* chats
 * (this-browser-only IndexedDB); this page lists the authoritative SERVER projects, so a build made on
 * another device is here too. It renders client-only because ownership is a session concern and the
 * "open in the same conversation" resolution needs IndexedDB — both live in the browser (§4.5.5).
 */
import { json, type MetaFunction } from '@remix-run/cloudflare';
import { ClientOnly } from 'remix-utils/client-only';
import { Header } from '~/components/header/Header';
import { Menu } from '~/components/sidebar/Menu.client';
import BackgroundRays from '~/components/ui/BackgroundRays';
import { ProjectsDashboard } from '~/components/projects/ProjectsDashboard.client';
import { brand } from '~/config/brand';

export const meta: MetaFunction = () => [
  { title: `Your Projects · ${brand.productFullName}` },
  { name: 'description', content: 'Open, remix, and manage the games you have built.' },
];

export const loader = () => json({});

export default function Dashboard() {
  return (
    <div className="flex flex-col h-full w-full bg-bolt-elements-background-depth-1">
      <BackgroundRays />
      <Header />
      {/* The same hover sidebar the builder has — chats, settings, New chat, so this view is never a dead end. */}
      <ClientOnly>{() => <Menu />}</ClientOnly>
      {/*
       * Scroll lives HERE, not on the outer container: a docked sidebar counter-translates the header
       * logo left over the sidebar, and `overflow-auto` on the outer box would clip it. Keeping the
       * outer box overflow-visible lets the logo show; only the project grid scrolls.
       */}
      <div className="flex-1 min-h-0 overflow-auto">
        <ClientOnly
          fallback={
            <div className="flex-1 flex items-center justify-center text-bolt-elements-textSecondary gap-2">
              <span className="i-svg-spinners:90-ring-with-bg" /> Loading…
            </div>
          }
        >
          {() => <ProjectsDashboard />}
        </ClientOnly>
      </div>
    </div>
  );
}
