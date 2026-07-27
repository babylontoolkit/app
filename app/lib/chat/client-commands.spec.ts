import { describe, expect, it } from 'vitest';
import { CLIENT_COMMAND_SUMMARIES, isClientCommandName, parseClientCommand } from './client-commands';
import { getSlashAutocomplete } from '~/lib/skills/slash';

describe('parseClientCommand', () => {
  it.each(['/clear', '/new', '/newchat'])('recognises %s', (cmd) => {
    expect(parseClientCommand(cmd)).toEqual({ kind: 'clear' });
  });

  it('is case-insensitive and tolerates surrounding whitespace', () => {
    expect(parseClientCommand('  /Clear ')).toEqual({ kind: 'clear' });
    expect(parseClientCommand('/NEW')).toEqual({ kind: 'clear' });
  });

  /*
   * The dangerous direction: a message the user meant for the AGENT must never be swallowed by the
   * client. Anything beyond the bare command falls through to the server untouched.
   */
  it('does NOT match a command with arguments or trailing prose', () => {
    expect(parseClientCommand('/clear the obstacles from the track')).toBeNull();
    expect(parseClientCommand('/new level with lava')).toBeNull();
  });

  it('does NOT match server /slash skill invocations or plain prose', () => {
    expect(parseClientCommand('/bt-landing neon cyberpunk theme')).toBeNull();
    expect(parseClientCommand('/bt-spec')).toBeNull();
    expect(parseClientCommand('please clear the chat')).toBeNull();
    expect(parseClientCommand('clear')).toBeNull();
  });

  it.each(['/context', '/usage', ' /Context '])('recognises %s as the context report', (cmd) => {
    expect(parseClientCommand(cmd)).toEqual({ kind: 'context' });
  });

  it('does NOT match /context with trailing prose', () => {
    expect(parseClientCommand('/context of the game story')).toBeNull();
  });

  it.each(['/effort', '/thinking', ' /Effort '])('recognises %s as the effort picker', (cmd) => {
    expect(parseClientCommand(cmd)).toEqual({ kind: 'effort' });
  });

  /*
   * `/effort high` is NOT a command. It reads like one, which is exactly why it is worth pinning: a
   * prefix match here would swallow "/effort high on the physics please" — and the picker exists partly
   * so the user sees what the expensive level costs before choosing it.
   */
  it('does NOT match /effort with an argument — the picker is the interface, not a flag', () => {
    expect(parseClientCommand('/effort high')).toBeNull();
    expect(parseClientCommand('/effort medium')).toBeNull();
    expect(parseClientCommand('/effort high on the collision code')).toBeNull();
  });

  it('does not match empty input', () => {
    expect(parseClientCommand('')).toBeNull();
    expect(parseClientCommand('   ')).toBeNull();
  });
});

describe('built-in command autocomplete', () => {
  it('every advertised command actually parses as a command — the menu cannot list a dead entry', () => {
    for (const command of CLIENT_COMMAND_SUMMARIES) {
      expect(command.builtin).toBe(true);
      expect(command.takesArgs).toBe(false);
      expect(parseClientCommand(`/${command.name}`)).not.toBeNull();
      expect(isClientCommandName(command.name)).toBe(true);
    }
  });

  it('is not fooled by a skill name', () => {
    expect(isClientCommandName('bt-landing')).toBe(false);
  });

  it('surfaces built-in commands in the `/` menu and floats them above skills', () => {
    const skills = [{ name: 'bt-landing', description: 'landing' }];
    const result = getSlashAutocomplete('/c', [...CLIENT_COMMAND_SUMMARIES, ...skills]);

    // Both built-ins match "/c"; they must come before any skill regardless of alphabetical order.
    expect(result?.matches[0].name).toBe('clear');
    expect(result?.matches[1].name).toBe('context');
    expect(result?.matches.every((m, i) => (m.builtin ? true : result.matches.slice(0, i).every((p) => p.builtin))));
  });

  it('shows every built-in when the input is a bare slash', () => {
    const result = getSlashAutocomplete('/', CLIENT_COMMAND_SUMMARIES);
    expect(result?.matches.map((m) => m.name)).toEqual(['clear', 'context', 'effort']);
  });
});
