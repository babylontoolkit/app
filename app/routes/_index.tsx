import { json, type MetaFunction } from '@remix-run/cloudflare';
import { ClientOnly } from 'remix-utils/client-only';
import { BaseChat } from '~/components/chat/BaseChat';
import { Chat } from '~/components/chat/Chat.client';
import { Header } from '~/components/header/Header';
import { SavingSurface } from '~/components/persistence/SavingSurface.client';
import BackgroundRays from '~/components/ui/BackgroundRays';
import { brand } from '~/config/brand';

export const meta: MetaFunction = () => {
  return [{ title: brand.productName }, { name: 'description', content: brand.metaDescription }];
};

export const loader = () => json({});

/**
 * Landing page component (the builder shell).
 * Note: Settings functionality should ONLY be accessed through the sidebar menu.
 * Do not add settings button/panel to this landing page as it was intentionally removed
 * to keep the UI clean and consistent with the design system.
 */
export default function Index() {
  return (
    <div className="flex flex-col h-full w-full bg-bolt-elements-background-depth-1">
      <BackgroundRays />
      <Header />
      {/*
       * Saving (§4.5.4b): the nudges, the unload warning, and the divergence choice. Mounted here
       * rather than inside the chat because `chat.$id` reuses this route, so one mount covers both a
       * fresh build and a resumed one — and a resumed project is exactly the case where the user has
       * forgotten the thing only exists in a tab.
       */}
      <ClientOnly>{() => <SavingSurface />}</ClientOnly>
      <ClientOnly fallback={<BaseChat />}>{() => <Chat />}</ClientOnly>
    </div>
  );
}
