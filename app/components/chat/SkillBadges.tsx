/**
 * "Which skills are running this turn" (SPEC §4.11).
 *
 * ONE component, two moments, deliberately identical: the live indicator while the turn streams
 * (fed by the server's `skills-loaded` data part) and the permanent footnote on the finished message
 * (fed by the `agentMeta` annotation). Two renderings of one fact would drift — that is the
 * two-writers problem this codebase keeps rediscovering — so both call sites import this.
 *
 * Why it exists at all: a skill running was previously visible only in a server log and a database
 * column. When a `/bt-spec` turn silently built a feature instead of writing a spec, the
 * contradiction — badge says `bt-spec`, output is a pause menu — would have been obvious at a glance.
 * Instead it took an argument and a `git show`. An invisible mechanism is one that fails invisibly
 * (`spec/fail-loud.md`).
 */
import { memo } from 'react';
import WithTooltip from '~/components/ui/Tooltip';

interface Props {
  skills: string[];

  /** `live` is the streaming indicator (spinner, brighter); `done` is the finished-message footnote. */
  variant?: 'live' | 'done';
}

export const SkillBadges = memo(({ skills, variant = 'done' }: Props) => {
  if (skills.length === 0) {
    return null;
  }

  const live = variant === 'live';

  return (
    <WithTooltip tooltip={`Skill${skills.length > 1 ? 's' : ''} loaded for this turn: ${skills.join(', ')}`}>
      <div className="flex items-center gap-1 flex-wrap">
        {skills.map((skill) => (
          <span
            key={skill}
            className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs border border-bolt-elements-borderColor ${
              live ? 'text-bolt-elements-textPrimary' : 'text-bolt-elements-textSecondary'
            }`}
          >
            <span className="i-ph:sparkle" />
            {skill}
          </span>
        ))}
      </div>
    </WithTooltip>
  );
});
