import { describe, expect, it } from 'vitest';
import { parseClientCommand } from './client-commands';

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

  it('does not match empty input', () => {
    expect(parseClientCommand('')).toBeNull();
    expect(parseClientCommand('   ')).toBeNull();
  });
});
