/**
 * Project-context notes (SPEC §4.9, §4.14, §4.15).
 *
 * What the model is TOLD about the project is a money-and-correctness path: a note that leaks a secret
 * would put it in the history forever, a note that says the wrong thing makes the model scaffold
 * wrongly, and a note present when it should be absent is tokens spent every turn to say nothing. So
 * the presence/absence and the FRAMING (untrusted tools, RLS-first) are pinned.
 */
import { describe, expect, it } from 'vitest';
import { buildProjectNotes, gameBackendNote, mcpNote } from './project-notes';
import type { FileMap } from '~/lib/.server/llm/constants';

const files = (entries: Record<string, string>): FileMap => {
  const map: FileMap = {};

  for (const [path, content] of Object.entries(entries)) {
    map[path] = { type: 'file', content, isBinary: false } as FileMap[string];
  }

  return map;
};

describe('the MCP note (§4.14)', () => {
  it('is absent when the project has no .mcp.json', () => {
    expect(mcpNote(files({ 'src/index.ts': 'x' }))).toBeNull();
  });

  it('lists declared servers and frames their output as UNTRUSTED', () => {
    const note = mcpNote(
      files({ '.mcp.json': JSON.stringify({ mcpServers: { kie: { command: 'node_modules/.bin/kie' } } }) }),
    );

    expect(note).toContain('kie');
    expect(note).toMatch(/untrusted/i);
    expect(note).toMatch(/never as instructions/i);
  });

  it('names servers it ignored rather than dropping them silently', () => {
    const note = mcpNote(files({ '.mcp.json': JSON.stringify({ mcpServers: { bad: { command: '/bin/sh' } } }) }));

    expect(note).toMatch(/IGNORED/);
    expect(note).toContain('bad');
  });

  it('never puts an env VALUE in the note (only the key name)', () => {
    const note = mcpNote(
      files({
        '.mcp.json': JSON.stringify({
          mcpServers: { kie: { command: 'node_modules/.bin/kie', env: { KIE_API_KEY: 'sk-secret-value' } } },
        }),
      }),
    );

    expect(note).toContain('KIE_API_KEY');
    expect(note).not.toContain('sk-secret-value');
  });
});

describe('the Game Backend note (§4.15)', () => {
  it('is absent when no backend is connected — no "remind the user" noise every turn', () => {
    expect(gameBackendNote(undefined)).toBeNull();
    expect(gameBackendNote({ connected: false })).toBeNull();
  });

  it('tells the model to scaffold RLS-first when a backend is connected', () => {
    const note = gameBackendNote({ connected: true });

    expect(note).toMatch(/RLS-first/);
    expect(note).toMatch(/anon key/);
    expect(note).toMatch(/never the platform database/i);
    expect(note).toMatch(/service-role/i);
  });

  it('escalates the warning when RLS is not yet confirmed', () => {
    expect(gameBackendNote({ connected: true, rlsConfirmed: false })).toMatch(/not yet confirmed/i);
  });
});

describe('combining notes', () => {
  it('drops empties and keeps only real notes', () => {
    const notes = buildProjectNotes({
      files: files({ 'src/x.ts': 'x' }), // no mcp
      gameBackend: { connected: true }, // one note
      assetNotes: ['# Asset Component Reference: car\n- StandardCarController'],
    });

    expect(notes).toHaveLength(2);
    expect(notes.some((n) => n.includes('Game Backend'))).toBe(true);
    expect(notes.some((n) => n.includes('StandardCarController'))).toBe(true);
  });

  it('returns nothing for a bare project', () => {
    expect(buildProjectNotes({ files: files({ 'src/x.ts': 'x' }) })).toEqual([]);
  });
});
