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

  it('prefers the LIVE running tools over the declared servers when the client reports them', () => {
    const note = mcpNote(
      files({ '.mcp.json': JSON.stringify({ mcpServers: { kie: { command: 'node_modules/.bin/kie' } } }) }),
      [{ name: 'generate_image', description: 'Make an image', server: 'kie' }],
    );

    // The actual tool name (what the model calls) appears, framed as running + untrusted.
    expect(note).toContain('generate_image');
    expect(note).toMatch(/running MCP tools/i);
    expect(note).toMatch(/untrusted/i);
  });

  it('shows a note for live tools even when there is no .mcp.json in the files', () => {
    const note = mcpNote(undefined, [{ name: 'search', server: 'remote' }]);

    expect(note).toContain('search');
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

describe('`unity` is an ordinary MCP server name, and buildProjectNotes never speaks for the Unity Bridge', () => {
  /*
   * The old §4.17 Editor bridge reserved `unity` as a routing label: a declared server wearing it was
   * refused at launch and filtered out of this note. That is gone — `unity` is an ordinary MCP server
   * name. The Unity Bridge (§4.17, D37) has its own per-turn notes in `bridge-notes.ts`, pushed by the
   * proxy AFTER the last cache breakpoint because they need server state (presence, job rows) this
   * module's pure inputs do not carry. Asserted so neither half creeps back in here silently.
   */
  it('describes a declared `unity` server like any other', () => {
    const note = mcpNote(
      files({
        '.mcp.json': JSON.stringify({ mcpServers: { unity: { command: 'node_modules/.bin/unity-mcp' } } }),
      }),
    );

    expect(note).toContain('unity');
    expect(note).not.toMatch(/GUIDED EXPORT|bridge has no file channel/i);
  });

  it('never emits a Unity Bridge note, even for a `unity`-tagged live tool', () => {
    const notes = buildProjectNotes({
      files: files({ '.mcp.json': JSON.stringify({ mcpServers: { unity: { command: 'x' } } }), 'src/x.ts': 'x' }),
      mcpLiveTools: [{ name: 'unity_open_scene', description: 'Open a scene', server: 'unity' }],
    });

    for (const note of notes) {
      expect(note).not.toMatch(/# Unity Bridge|Unity Exporter|helper is not running|Local scene server/i);
    }

    // Control: the live tool still reaches the notes at all, so the absence above is about the FRAME.
    expect(notes.join('\n')).toContain('unity_open_scene');
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
