/**
 * The one git control in the header (SPEC §4.5.4b, §4.5.4c, §4.13).
 *
 * ## What this replaced, and why it had to be one thing
 *
 * The header grew FOUR separate controls for a single idea — "where does my game live?":
 *
 *   1. a `Not synced to GitHub` badge (state, no action),
 *   2. a `GitHub ▾` provider `<select>` (only while unlinked, only with >1 provider configured),
 *   3. a `Sync` button that pushes the current work (`SaveStatus`),
 *   4. a `Sync` button that opens the repo dialog — pull, link, divergence (`GitHubSyncButton`).
 *
 * 3 and 4 shipped with the SAME LABEL. Not a typo: 4 was deliberately renamed from "GitHub" to "Sync"
 * so it would stop competing with the button then called "Save" — and §4.5.4c later renamed "Save" to
 * "Sync", handing it the exact word the other one had just moved away from. Neither change was wrong on
 * its own; nothing was checking that the header still read sensibly as a WHOLE. Two adjacent buttons
 * with one label and two different verbs is not a naming problem, it is a missing grouping.
 *
 * So: one chip that shows the state and opens a menu of everything you can do about that state. The
 * user reads one thing, and the actions are children of it rather than siblings competing with it.
 *
 * ## What is deliberately kept from the old version
 *
 * **The asymmetry (§4.5.4b).** Unlinked is amber and says the awkward thing out loud; synced is grey
 * and nearly invisible. A user's default belief in 2026 is that everything saves itself, so the state
 * that contradicts that belief carries the weight. A quieter chip would be prettier and worse.
 *
 * **Every string still comes from `describeSaveStatus`** (pure, exhaustively tested — including a sweep
 * proving no combination of states yields a badge claiming "synced" when it is not). This file draws
 * what that function returns. A string invented here is a string nothing tests.
 *
 * **It renders whenever there is a project** — never gated on a running preview. A project that failed
 * to build is exactly the one whose code the user cannot afford to lose.
 */
import { useState } from 'react';
import { useStore } from '@nanostores/react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { classNames } from '~/utils/classNames';
import { projectId as projectIdStore, repoStatus, unsavedWork, requestSave, startGitConnect } from '~/lib/persistence';
import { saveState } from '~/lib/persistence/save-queue';
import { describeSaveStatus, type SaveTone } from '~/lib/persistence/save-status';
import { GitHubSyncDialog } from '~/components/github/GitHubSyncButton';
import { TOOLBAR_MENU_CONTENT, TOOLBAR_MENU_ITEM } from './toolbar-button';

type GitProvider = 'github' | 'gitlab';

const PROVIDER_LABEL: Record<GitProvider, string> = { github: 'GitHub', gitlab: 'GitLab' };

/** Where a linked project's code actually is, so "Open on GitHub" can be a real link. */
const PROVIDER_ORIGIN: Record<GitProvider, string> = {
  github: 'https://github.com',
  gitlab: 'https://gitlab.com',
};

function providerFromReturn(): GitProvider {
  if (typeof window === 'undefined') {
    return 'github';
  }

  return new URLSearchParams(window.location.search).get('provider') === 'gitlab' ? 'gitlab' : 'github';
}

/*
 * Tone drives the chip's colour and nothing else.
 *
 * 🔴 `busy` and `neutral` deliberately match `TOOLBAR_BUTTON` EXACTLY — same border, no fill — so a
 * project that is synced or mid-sync sits in the row looking like every other control. Only `warning`
 * and `danger` break out of the uniform, which is the §4.5.4b asymmetry expressed in colour: a synced
 * project should feel like nothing, and an unsynced one should feel like something. If you restyle the
 * toolbar button, restyle these two with it or the "nothing to worry about" states start shouting.
 */
const TONE_CLASSES: Record<SaveTone, string> = {
  danger: 'text-red-300 border-red-500/50 bg-red-500/15 hover:bg-red-500/25',
  warning: 'text-amber-300 border-amber-500/50 bg-amber-500/15 hover:bg-amber-500/25',
  busy: 'text-bolt-elements-textPrimary border-white/15 hover:bg-white/10',
  neutral: 'text-bolt-elements-textPrimary border-white/15 hover:bg-white/10',
};

const TONE_ICONS: Record<SaveTone, string> = {
  danger: 'i-ph:warning-circle-fill',
  warning: 'i-ph:warning-circle',
  busy: 'i-svg-spinners:90-ring-with-bg',
  neutral: 'i-ph:check-circle',
};

export function GitStatusChip() {
  const activeProjectId = useStore(projectIdStore);
  const repo = useStore(repoStatus);
  const unsaved = useStore(unsavedWork);
  const state = useStore(saveState);

  const [chosenProvider, setChosenProvider] = useState<GitProvider>(providerFromReturn);
  const [dialogOpen, setDialogOpen] = useState(false);

  if (!activeProjectId) {
    return null;
  }

  /*
   * A brand-new project can be saved to more than one account when the deployment has both providers
   * configured. Offer the choice ONLY while unlinked and only when there IS a choice — once linked, the
   * project's own provider is authoritative. Without this, GitLab is unreachable: every action silently
   * defaults to GitHub.
   */
  const configured = (repo?.configuredProviders ?? []) as GitProvider[];
  const hasChoice = !repo?.linked && configured.length > 1;

  /*
   * The provider every label and action must agree on: the project's own once linked, otherwise the one
   * the user picked. Computed BEFORE the view so the copy names the right account.
   */
  const providerToUse: GitProvider = repo?.provider ?? (hasChoice ? chosenProvider : (configured[0] ?? 'github'));

  const view = describeSaveStatus({ repo, unsavedWork: unsaved, saveState: state, chosenProvider: providerToUse });
  const providerName = PROVIDER_LABEL[providerToUse];

  const runAction = () => {
    if (view.action === 'reconnect') {
      startGitConnect(providerToUse);
      return;
    }

    // `save` and `retry` are the same call. The distinction is what the user is told, not what we do.
    void requestSave(activeProjectId, providerToUse);
  };

  return (
    <>
      {/*
       * 🔴 `modal={false}` is load-bearing, same reason as DeployButton (§4.1a). Radix's modal default
       * scroll-locks the body and pads it to compensate for the scrollbar; the chat column is IN FLOW so
       * that padding SHIFTS it, while the workbench (position: fixed, placed by --workbench-left) stays
       * put — opening this menu shoved the whole chat off-screen left. Non-modal keeps the menu out of
       * the layout's business, matching every other dropdown in the header.
       */}
      <DropdownMenu.Root modal={false}>
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            title={view.detail}
            className={classNames(
              'flex items-center gap-1.5 h-7 pl-2 pr-1.5 text-xs font-medium rounded-md border',
              'whitespace-nowrap transition-colors outline-none',
              TONE_CLASSES[view.tone],
            )}
          >
            <div className={classNames(TONE_ICONS[view.tone], 'shrink-0 text-sm')} />
            <span>{view.label}</span>
            <div className="i-ph:caret-down text-[10px] opacity-70" />
          </button>
        </DropdownMenu.Trigger>

        <DropdownMenu.Portal>
          {/*
           * `max-w` is load-bearing, not cosmetic: `view.detail` is a full sentence, and without a
           * bound the menu grew to the width of that sentence — measured 1,355px, most of the screen.
           * A menu is sized by its ACTIONS; the prose has to wrap to them.
           */}
          <DropdownMenu.Content
            align="end"
            sideOffset={6}
            className={classNames(TOOLBAR_MENU_CONTENT, 'min-w-[260px] max-w-[320px]')}
          >
            {/*
             * The state, restated in full. The chip is short enough for a header ("Not synced"); the
             * detail sentence is the part that actually explains it, and a tooltip is the wrong place
             * for the only explanation of a thing a user is worried about.
             */}
            <div className="px-3 py-2 text-xs text-bolt-elements-textSecondary leading-relaxed">{view.detail}</div>

            <DropdownMenu.Separator className="h-px bg-bolt-elements-borderColor my-1" />

            {view.action !== 'none' && (
              <DropdownMenu.Item className={TOOLBAR_MENU_ITEM} onSelect={runAction}>
                <div className={view.action === 'reconnect' ? 'i-ph:plugs' : 'i-ph:cloud-arrow-up'} />
                <span>{view.actionLabel}</span>
              </DropdownMenu.Item>
            )}

            {/*
             * The old fourth control. It is the OTHER thing you do with a repo — pull down external
             * changes, resolve divergence, link a repo you already have — so it belongs under the same
             * chip as an item with its own verb, not beside it as a second button called "Sync".
             */}
            <DropdownMenu.Item className={TOOLBAR_MENU_ITEM} onSelect={() => setDialogOpen(true)}>
              <div className="i-ph:git-branch" />
              <span>{repo?.linked ? `Pull from ${providerName}…` : 'Link a repository…'}</span>
            </DropdownMenu.Item>

            {repo?.linked && repo.repo && (
              <DropdownMenu.Item
                className={TOOLBAR_MENU_ITEM}
                onSelect={() => window.open(`${PROVIDER_ORIGIN[providerToUse]}/${repo.repo}`, '_blank')}
              >
                <div className="i-ph:arrow-square-out" />
                <span className="truncate">Open {repo.repo}</span>
              </DropdownMenu.Item>
            )}

            {hasChoice && (
              <>
                <DropdownMenu.Separator className="h-px bg-bolt-elements-borderColor my-1" />
                <DropdownMenu.Label className="px-3 py-1 text-[11px] uppercase tracking-wide text-bolt-elements-textTertiary">
                  Create the repository on
                </DropdownMenu.Label>
                <DropdownMenu.RadioGroup
                  value={chosenProvider}
                  onValueChange={(v) => setChosenProvider(v as GitProvider)}
                >
                  {configured.map((p) => (
                    <DropdownMenu.RadioItem key={p} value={p} className={TOOLBAR_MENU_ITEM}>
                      <div
                        className={classNames(
                          chosenProvider === p ? 'i-ph:radio-button-fill text-accent-500' : 'i-ph:circle opacity-50',
                        )}
                      />
                      <span>{PROVIDER_LABEL[p]}</span>
                    </DropdownMenu.RadioItem>
                  ))}
                </DropdownMenu.RadioGroup>
              </>
            )}

            <DropdownMenu.Separator className="h-px bg-bolt-elements-borderColor my-1" />

            {/*
             * "Not synced" raises a question in the reader's head — where IS it, then? — and the answer
             * has to be one click from where the question is asked, or the chip is an unexplained worry.
             */}
            <DropdownMenu.Item
              className={classNames(TOOLBAR_MENU_ITEM, 'text-bolt-elements-textSecondary')}
              onSelect={() => window.open('/help/saving-projects', '_blank')}
            >
              <div className="i-ph:question" />
              <span>Where does my game live?</span>
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>

      {dialogOpen && <GitHubSyncDialog projectId={activeProjectId} onClose={() => setDialogOpen(false)} />}
    </>
  );
}
