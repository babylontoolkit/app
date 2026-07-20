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

describe('the Unity Exporter block (§4.17)', () => {
  const unityTool = { name: 'unity_open_scene', description: 'Open a scene', server: 'unity' };

  it('frames the bridge and pins the GUIDED EXPORT contract when a unity tool is live', () => {
    const note = mcpNote(undefined, [unityTool]);

    expect(note).toContain('## Unity Exporter');

    /* WHERE the tools act — a Unity change is invisible to the web game until it is exported. */
    expect(note).toMatch(/local unity exporter/i);
    expect(note).toMatch(/NOT on the web project files/i);

    /* The guided export: run the exporter, then TELL THE USER to import — the platform moves nothing. */
    expect(note).toMatch(/exporter/i);
    expect(note).toMatch(/tell the\s+user to import/i);

    /*
     * The constraint that makes the contract honest. A model that announces the assets have arrived, or
     * invents a path for one, is describing something that did not happen — and the user acts on it.
     */
    expect(note).toMatch(/cannot move those files yourself/i);
    expect(note).toMatch(/never state or imply that exported assets are already in the project/i);
    expect(note).toMatch(/never invent paths/i);

    /* Slow editor operations, and the same untrusted-results frame as any other MCP tool. */
    expect(note).toMatch(/one clear editor operation at a time/i);
    expect(note).toMatch(/untrusted/i);
  });

  it('is absent when the live tools come from some other server', () => {
    const note = mcpNote(undefined, [{ name: 'search_docs', server: 'docs' }]);

    expect(note).toContain('search_docs');
    expect(note).not.toContain('Unity Exporter');
    expect(note).not.toMatch(/unity/i);
  });

  it('is absent when there are no live tools at all', () => {
    const note = mcpNote(
      files({ '.mcp.json': JSON.stringify({ mcpServers: { kie: { command: 'node_modules/.bin/kie' } } }) }),
    );

    expect(note).not.toContain('Unity Exporter');
  });

  /*
   * The block rides the MCP note, which lives in the VOLATILE tail (§4.2.8) — it must never become a
   * cached block, and it must survive the entry point the proxy actually calls.
   */
  it('travels through buildProjectNotes — the volatile-tail entry point', () => {
    const notes = buildProjectNotes({ files: files({ 'src/x.ts': 'x' }), mcpLiveTools: [unityTool] });

    expect(notes.some((n) => n.includes('## Unity Exporter'))).toBe(true);
  });

  /*
   * `unity` is a RESERVED label (§4.17): the bridge owns it, so a declared server by that name is never
   * launched. The model must therefore never be told one is available — describing a server that cannot
   * start buys only failed tool calls. With nothing else declared, the whole note collapses to null.
   */
  it('never advertises a declared `unity` server — the reserved name is filtered out', () => {
    const declared = files({
      '.mcp.json': JSON.stringify({ mcpServers: { unity: { command: 'node_modules/.bin/unity-mcp' } } }),
    });

    expect(mcpNote(declared)).toBeNull();
    expect(buildProjectNotes({ files: declared })).toEqual([]);
  });

  it('filters the reserved name without disturbing the servers declared alongside it', () => {
    const note = mcpNote(
      files({
        '.mcp.json': JSON.stringify({
          mcpServers: {
            unity: { command: 'node_modules/.bin/unity-mcp' },
            kie: { command: 'node_modules/.bin/kie' },
          },
        }),
      }),
    );

    expect(note).toContain('kie');
    expect(note).not.toMatch(/unity/i);
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
