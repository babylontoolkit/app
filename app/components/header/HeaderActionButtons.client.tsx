/**
 * The header toolbar (SPEC §4.4c, §4.8, §4.13, §4.16).
 *
 * ## The shape, and why it is this shape
 *
 * This row grew one button per feature over about a dozen changes, each individually reasonable, and
 * arrived at ELEVEN controls — six of them identical accent-filled pills — with two adjacent buttons
 * both labelled "Sync". Two failures, and the second is the interesting one:
 *
 *   - **No hierarchy.** Workbench, Media, Share, Report Bug, Debug Log and Deploy were all the same
 *     filled purple. A toolbar where everything is primary has no primary, so the eye has to read every
 *     label every time. Diagnostics looked exactly as important as shipping your game.
 *   - **No grouping.** The four git controls (badge, provider picker, push button, repo dialog) were
 *     four siblings answering ONE question — "where does my game live?" — so nothing showed they were
 *     related, and the two verbs both ended up called "Sync" because each was named against its
 *     neighbour rather than against the row. **A name collision between siblings is usually a missing
 *     parent.** See `GitStatusChip`.
 *
 * So: **every action in this row looks identical** — one shared style in `toolbar-button.ts`, imported,
 * never re-typed. Tiering the buttons by importance was tried first (filled primary / bordered
 * secondary / bare tertiary) and rejected by the owner: a row wearing four different looks reads as
 * mess before it reads as hierarchy, and the labels already say what each one does.
 *
 * **The git chip is the single deliberate exception**, because it carries STATE rather than an action:
 * §4.5.4b requires the unsynced state to be loud (amber) and the synced state to be quiet, an asymmetry
 * that cannot survive a uniform style and is the entire point of the badge.
 *
 * General options live in the ⋯ **main menu** (New chat, Export ZIP, bug report, debug log), which is
 * also where new ones go by default. The row is the exception, not the destination.
 *
 * ## 🔴 THE ROW MUST NOT RESIZE WHEN THE PREVIEW BOOTS
 *
 * This group is right-aligned, so it grows LEFTWARD: anything appearing to the RIGHT of a button shoves
 * that button left. Share and Deploy need a running preview (you cannot share a game that has not
 * built) and the preview takes seconds, so they used to POP IN — measured: `New chat` sat 16px from the
 * right edge at t=0 and 486px at t=4s. Reported as "the New chat button is very inconsistent".
 *
 * The old fix was ordering — conditional buttons first, always-present ones last — which worked but
 * made the order load-bearing and fragile (any new conditional button placed wrong re-broke it). The
 * fix now is that **preview-gated controls render DISABLED rather than absent**: they hold their space
 * from the first paint, and the tooltip says why they are not ready yet. Nothing moves, the order is
 * free to be semantic, and the user can SEE that sharing exists before it is available — which is
 * better than discovering it appear.
 *
 * If you add a control here: decide its tier, and if it needs the preview, disable it — never hide it.
 */
import { useState } from 'react';
import { useStore } from '@nanostores/react';
import { workbenchStore } from '~/lib/stores/workbench';
import { projectId as projectIdStore } from '~/lib/persistence';
import { DeployButton } from '~/components/deploy/DeployButton';
import { ShareButton } from '~/components/share/ShareButton';
import { MediaButton } from '~/components/media/MediaButton';
import { GitStatusChip } from './GitStatusChip.client';
import { OverflowMenu } from './OverflowMenu.client';
import { TOOLBAR_ICON_BUTTON } from './toolbar-button';

interface HeaderActionButtonsProps {
  chatStarted: boolean;
}

export function HeaderActionButtons({ chatStarted: _chatStarted }: HeaderActionButtonsProps) {
  const [activePreviewIndex] = useState(0);
  const previews = useStore(workbenchStore.previews);
  const showWorkbench = useStore(workbenchStore.showWorkbench);
  const activeProjectId = useStore(projectIdStore);
  const activePreview = previews[activePreviewIndex];

  if (!activeProjectId) {
    return null;
  }

  return (
    <div className="flex items-center gap-1.5">
      {/*
       * Workbench toggle — a split-panel icon (code | preview), which is what the workbench IS.
       *
       * No FILL, by owner request: the fill is reserved for the two controls that should stand out — the
       * git chip and the ⋯ main menu. This is a plain bordered button like Media/Share/Deploy even when
       * the workbench is open; `aria-pressed` still carries the on/off state for assistive tech, it just
       * is not shouted visually.
       *
       * Gated on a PROJECT, not the preview: the chat-only view (workbench closed by its ✕) previously
       * had NO way back — only a reload or a generation that wrote files ever set `showWorkbench` again.
       */}
      <button
        type="button"
        onClick={() => workbenchStore.showWorkbench.set(!showWorkbench)}
        title={showWorkbench ? 'Hide the workbench' : 'Open the workbench (code, files, preview)'}
        aria-label="Toggle the workbench"
        aria-pressed={showWorkbench}
        className={TOOLBAR_ICON_BUTTON}
      >
        <div className="i-ph:square-split-horizontal-bold text-sm" />
      </button>

      {/* Built-in image/video generation (§4.16) — secondary. */}
      <MediaButton />

      {/* Publish to a public /play build (§4.8) — the primary action, the only filled button here. */}
      <ShareButton disabled={!activePreview} />

      {/* Deploy to Netlify/Vercel/etc — secondary. Disables itself without a preview. */}
      <DeployButton />

      {/*
       * The ONE git control (§4.5.4b, §4.5.4c, §4.13): state + every action you can take about it.
       * Replaces the badge, the provider picker, the push button and the repo dialog.
       *
       * Deliberately NOT preview-gated. Everything above needs a build; this is the opposite — a project
       * that failed to build is precisely the one whose code the user cannot afford to lose.
       */}
      <GitStatusChip />

      {/*
       * The MAIN MENU (last, so it reads as "everything else"): New chat, Export ZIP, bug report, debug
       * log — and where future general options go. Needs no preview; a broken build is one of the
       * likeliest times to want a clean context to debug from.
       */}
      <OverflowMenu />
    </div>
  );
}
