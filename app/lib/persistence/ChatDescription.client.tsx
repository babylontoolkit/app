import { useEffect, useState } from 'react';
import { useStore } from '@nanostores/react';
import { TooltipProvider } from '@radix-ui/react-tooltip';
import WithTooltip from '~/components/ui/Tooltip';
import { useEditChatDescription } from '~/lib/hooks';
import { chatMetadata, description as descriptionStore, projectId as projectIdStore } from '~/lib/persistence';
import { getProject } from '~/lib/persistence/projects';

export function ChatDescription() {
  const initialDescription = useStore(descriptionStore)!;
  const activeProjectId = useStore(projectIdStore);

  /*
   * The active chat's server home (§4.5.6) — the rename must land there, or the sidebar (which
   * renders the SERVER's list) reverts it on the next refresh and other devices never see it.
   */
  const metadata = useStore(chatMetadata);
  const serverTarget =
    metadata?.projectId && metadata?.serverChatId
      ? { projectId: metadata.projectId, serverChatId: metadata.serverChatId }
      : undefined;

  const { editing, handleChange, handleBlur, handleSubmit, handleKeyDown, currentDescription, toggleEditMode } =
    useEditChatDescription({
      initialDescription,
      syncWithGlobalStore: true,
      serverTarget,
    });

  /*
   * The PROJECT title, as a fallback: a fresh chat has no description until its first message names
   * one (§4.5.6 — identity is built from scratch, never inherited), which left the title bar EMPTY on
   * "New chat, same game" — the user is looking at a project with no visible name. One cheap read per
   * project change; best-effort (an offline miss just keeps the bar empty as before).
   */
  const [projectTitle, setProjectTitle] = useState<string | undefined>();

  useEffect(() => {
    if (!activeProjectId) {
      setProjectTitle(undefined);
      return undefined;
    }

    let cancelled = false;
    getProject(activeProjectId)
      .then((project) => {
        if (!cancelled) {
          setProjectTitle(project.name);
        }
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [activeProjectId]);

  if (!initialDescription) {
    /*
     * No chat name yet — show the PROJECT's name (plain, no rename pencil: the pencil renames the
     * CHAT, and there is no chat identity to rename yet). Nothing at all only when there is no
     * project either (the landing page).
     */
    return projectTitle ? <div className="flex items-center justify-center">{projectTitle}</div> : null;
  }

  return (
    <div className="flex items-center justify-center">
      {editing ? (
        <form onSubmit={handleSubmit} className="flex items-center justify-center">
          <input
            type="text"
            className="bg-bolt-elements-background-depth-1 text-bolt-elements-textPrimary rounded px-2 mr-2 w-fit"
            autoFocus
            value={currentDescription}
            onChange={handleChange}
            onBlur={handleBlur}
            onKeyDown={handleKeyDown}
            style={{ width: `${Math.max(currentDescription.length * 8, 100)}px` }}
          />
          <TooltipProvider>
            <WithTooltip tooltip="Save title">
              <div className="flex justify-between items-center p-2 rounded-md bg-bolt-elements-item-backgroundAccent">
                <button
                  type="submit"
                  className="i-ph:check-bold scale-110 hover:text-bolt-elements-item-contentAccent"
                  onMouseDown={handleSubmit}
                />
              </div>
            </WithTooltip>
          </TooltipProvider>
        </form>
      ) : (
        <>
          {currentDescription}
          <TooltipProvider>
            <WithTooltip tooltip="Rename chat">
              <button
                type="button"
                className="ml-2 i-ph:pencil-fill scale-110 hover:text-bolt-elements-item-contentAccent"
                onClick={(event) => {
                  event.preventDefault();
                  toggleEditMode();
                }}
              />
            </WithTooltip>
          </TooltipProvider>
        </>
      )}
    </div>
  );
}
