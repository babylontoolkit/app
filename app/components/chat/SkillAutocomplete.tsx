/**
 * `/` skill autocomplete for the chat input (SPEC §4.11, invocation path 1).
 *
 * Typing `/` opens a menu of synced skills (name + description); picking one completes the command
 * so the user can type the task after it. This is the headline UX of the skills subsystem — the
 * point being that `/bt-spec <task>` works in the platform chat exactly as it does in Claude Code.
 */
import { AnimatePresence, motion } from 'framer-motion';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { classNames } from '~/utils/classNames';
import { getSlashAutocomplete, type SkillSummary } from '~/lib/skills/slash';
import { CLIENT_COMMAND_SUMMARIES, isClientCommandName } from '~/lib/chat/client-commands';

/** Fetched once per session — the skill set only changes on an admin resync. */
function useSyncedSkills(): SkillSummary[] {
  const [skills, setSkills] = useState<SkillSummary[]>([]);

  useEffect(() => {
    let cancelled = false;

    fetch('/api/skills')
      .then((response) => (response.ok ? (response.json() as Promise<{ skills?: SkillSummary[] }>) : { skills: [] }))
      .then((data) => {
        if (!cancelled) {
          setSkills(data.skills ?? []);
        }
      })
      .catch(() => {
        // No skills synced yet is a normal state, not an error worth shouting about.
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return skills;
}

export interface SkillAutocomplete {
  isOpen: boolean;
  matches: SkillSummary[];
  activeIndex: number;
  setActiveIndex: (index: number) => void;
  accept: (skill: SkillSummary) => void;

  /**
   * Call FIRST from the textarea's own `onKeyDown`. When the menu is open this consumes the
   * navigation keys and calls `preventDefault()` — so Enter completes the skill instead of sending a
   * half-typed `/bt-sp` as a chat message.
   */
  handleKeyDown: (event: React.KeyboardEvent) => void;
}

export function useSkillAutocomplete(input: string, setInput: (value: string) => void): SkillAutocomplete {
  const skills = useSyncedSkills();
  const [activeIndex, setActiveIndex] = useState(0);
  const [dismissed, setDismissed] = useState(false);

  // Built-in client commands (/clear, /context) share the menu with synced skills — the sort floats them first.
  const entries = useMemo(() => [...CLIENT_COMMAND_SUMMARIES, ...skills], [skills]);

  const suggestion = useMemo(() => getSlashAutocomplete(input, entries), [input, entries]);
  const matches = suggestion?.matches ?? [];
  const isOpen = !dismissed && matches.length > 0;

  // A fresh `/` after dismissing should reopen the menu.
  const previousInput = useRef(input);

  useEffect(() => {
    if (previousInput.current !== input) {
      previousInput.current = input;
      setDismissed(false);
      setActiveIndex(0);
    }
  }, [input]);

  const accept = useCallback(
    (skill: SkillSummary) => {
      /*
       * A zero-arg client command completes exactly (a trailing space + text turns it back into a message);
       * a skill completes with a trailing space, because the user's next keystroke is the task.
       */
      setInput(isClientCommandName(skill.name) ? `/${skill.name}` : `/${skill.name} `);
      setDismissed(true);
    },
    [setInput],
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (!isOpen) {
        return;
      }

      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setActiveIndex((index) => (index + 1) % matches.length);
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        setActiveIndex((index) => (index - 1 + matches.length) % matches.length);
      } else if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        accept(matches[Math.min(activeIndex, matches.length - 1)]);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        setDismissed(true);
      }
    },
    [isOpen, matches, activeIndex, accept],
  );

  return { isOpen, matches, activeIndex, setActiveIndex, accept, handleKeyDown };
}

export function SkillAutocompleteMenu({ autocomplete }: { autocomplete: SkillAutocomplete }) {
  const { isOpen, matches, activeIndex, setActiveIndex, accept } = autocomplete;

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 4 }}
          transition={{ duration: 0.12 }}
          className={classNames(
            'absolute bottom-full left-0 right-0 mb-2 z-50 overflow-hidden',
            'rounded-lg border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2',
            'shadow-lg max-h-64 overflow-y-auto',
          )}
        >
          <div className="px-3 py-2 text-xs text-bolt-elements-textTertiary border-b border-bolt-elements-borderColor">
            Commands &amp; skills — <kbd>↑</kbd> <kbd>↓</kbd> to navigate, <kbd>Enter</kbd> to select
          </div>
          {matches.map((skill, index) => (
            <button
              key={skill.name}
              type="button"
              onMouseDown={(event) => {
                // Mouse DOWN, not click: the textarea must not lose focus before we complete the text.
                event.preventDefault();
                accept(skill);
              }}
              onMouseEnter={() => setActiveIndex(index)}
              className={classNames(
                'w-full text-left px-3 py-2 transition-theme',
                index === activeIndex
                  ? 'bg-bolt-elements-item-backgroundAccent'
                  : 'bg-transparent hover:bg-bolt-elements-item-backgroundActive',
              )}
            >
              <div
                className={classNames(
                  'text-sm font-medium',
                  index === activeIndex ? 'text-bolt-elements-item-contentAccent' : 'text-bolt-elements-textPrimary',
                )}
              >
                /{skill.name}
              </div>
              <div className="text-xs text-bolt-elements-textSecondary line-clamp-2">{skill.description}</div>
            </button>
          ))}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
