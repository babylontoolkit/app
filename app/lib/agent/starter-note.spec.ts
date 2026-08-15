/**
 * 🔴 THE STARTER GAME TYPE DECIDES THE BASE SCENE (owner, 2026-08-14).
 *
 * *"If you have a scene_url, then load it in the navigate play route along with your custom game mode…
 * If the card does not have a scene_url then don't pass anything for it in the navigate."*
 *
 * `scene_url` was declared on `GameRegistryEntry`, set on three rows, and read by NOTHING — no code,
 * no prompt, nowhere in the repo. Picking a card decided which controller got copied and never the
 * world it ran in, while SPEC §4.4b step 4 had specified both since the registry was designed.
 *
 * Every assertion here is mutation-verified.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { starterGameTypeFrom, starterGameTypeNote } from './starter-note';
import { findRegistryEntry, REGISTRY_ENTRIES } from '~/lib/registry/entries';

/** The `navigate('/play', …)` line out of the note's code fence — the thing the model copies. */
function navigateCall(note: string): string {
  const line = note.split('\n').find((l) => l.includes("navigate('/play'"));
  expect(line, 'the note must show the play contract call').toBeDefined();

  return line as string;
}

describe('starterGameTypeNote — the scene half', () => {
  const WITH_SCENE = { title: 'Arcade Racing', sourceClass: 'VehicleControllerDemo.ts', sceneUrl: 'https://x/t.gltf' };
  const NO_SCENE = { title: 'Blank Canvas', sourceClass: 'DefaultGameMode.ts' };

  it('passes the scene through the play contract when the card defines one', () => {
    const note = starterGameTypeNote(WITH_SCENE);

    expect(note).toContain('https://x/t.gltf');
    expect(navigateCall(note!)).toMatch(/sceneUrl: 'https:\/\/x\/t\.gltf'/);
  });

  /**
   * 🔴 THE ABSENT BRANCH IS NOT A SMALLER VERSION OF THE PRESENT ONE. A `sceneUrl: undefined` left in
   * the call, or an invented URL standing in for a scene the starter does not have, both produce a
   * `/play` route that resolves nothing — and an invented one fails at RUNTIME, where this codebase's
   * whole history says failures are hardest to see.
   */
  it('omits sceneUrl ENTIRELY when the card defines none', () => {
    const note = starterGameTypeNote(NO_SCENE);
    const call = navigateCall(note!);

    expect(call).not.toContain('sceneUrl');
    expect(call).toContain('gameMode');
    expect(note).toMatch(/omit `sceneUrl`/);
  });

  /* No starter (an unregistered project, or a row that no longer exists) says nothing at all. */
  it('is null when there is no starter', () => {
    expect(starterGameTypeNote(null)).toBeNull();
    expect(starterGameTypeNote(undefined)).toBeNull();
  });

  /**
   * The scaffolded copy is what runs; the library class is read-only reference material. Pointing the
   * play contract at the source class names an unregistered mode and dead-ends at `/play`.
   */
  it('sends the model to the scaffolded class, never the library one it was copied from', () => {
    const note = starterGameTypeNote(WITH_SCENE)!;

    expect(navigateCall(note)).not.toContain('VehicleControllerDemo');
    expect(note).toMatch(/never invent one/i);
    expect(note).toMatch(/never point the play contract at the library class/i);
  });

  /**
   * ⚠️ The baked prompt says in bold that the playground scenes the reference docs teach with are
   * examples and never a default — and a configured `scene_url` may well be one of them. Unstated,
   * the model reads the two as one instruction and drops a scene it was deliberately given, which
   * looks exactly like the feature not working.
   */
  it('tells the model the demo-assets rule does not apply to a configured scene', () => {
    expect(starterGameTypeNote(WITH_SCENE)).toMatch(/demo assets are an example, never a default/i);

    /* And says nothing about it when there is no scene — there is no conflict to resolve. */
    expect(starterGameTypeNote(NO_SCENE)).not.toMatch(/demo assets/i);
  });
});

describe('starterGameTypeFrom — narrowing a row', () => {
  it('carries the scene only when the row has one', () => {
    const racing = starterGameTypeFrom(findRegistryEntry('gm_racing_v1'));
    expect(racing?.sceneUrl).toBeTruthy();

    /* Physics Playground and Blank Canvas define no scene — the absent branch is real, not theoretical. */
    expect(starterGameTypeFrom(findRegistryEntry('gm_physics_v1'))?.sceneUrl).toBeUndefined();
    expect(starterGameTypeFrom(findRegistryEntry('gm_blank_v1'))?.sceneUrl).toBeUndefined();
  });

  it('is null for no row', () => {
    expect(starterGameTypeFrom(null)).toBeNull();
    expect(starterGameTypeFrom(undefined)).toBeNull();
  });
});

describe('findRegistryEntry', () => {
  it('resolves every shipped row by its own id', () => {
    expect(REGISTRY_ENTRIES.length).toBeGreaterThan(0);

    for (const entry of REGISTRY_ENTRIES) {
      expect(findRegistryEntry(entry.id)?.id).toBe(entry.id);
    }
  });

  /*
   * An unknown id is an ordinary state — a retired row, or a project made through a path that records
   * no starter. It must resolve to nothing, never to the first row: a project told it started from the
   * wrong starter gets a base scene that is not its own.
   */
  it('returns null rather than guessing', () => {
    expect(findRegistryEntry('gm_does_not_exist')).toBeNull();
    expect(findRegistryEntry(undefined)).toBeNull();
    expect(findRegistryEntry('')).toBeNull();
  });
});

/**
 * 🔴 WIRED — the note is a pure function and does nothing until something sends it.
 *
 * This is the state `scene_url` itself was in for the entire life of the registry: a correct, declared,
 * populated field with no reader.
 */
describe('the starter note reaches the model', () => {
  const PROXY = readFileSync(join(process.cwd(), 'app/lib/.server/agent/proxy.ts'), 'utf8');
  const ROUTE = readFileSync(join(process.cwd(), 'app/routes/api.agent.ts'), 'utf8');

  /**
   * 🔴 FROM THE ROW, NEVER THE BODY — the `owesBuild` rule. A caller who could name their own starter
   * could hand themselves a base scene from a project that is not theirs.
   */
  it('the route resolves the starter from the ownership-checked project row', () => {
    expect(ROUTE).toMatch(/starterId: project\?\.templateId/);
    expect(ROUTE, 'never from the request body').not.toMatch(/starterId: body\./);
  });

  it('the proxy builds the note and pushes it', () => {
    expect(PROXY).toMatch(/starterGameTypeNote\(starterGameTypeFrom\(findRegistryEntry\(request\.starterId\)\)\)/);
    expect(PROXY).toMatch(/system\.push\(\{ role: 'system', content: starterNote \}\)/);
  });

  /**
   * 🔴 IN THE UNCACHED TAIL. Ahead of the last breakpoint it would sit inside the ~110k-token
   * file-context entry and rewrite it at the 2× cache-WRITE rate — the defect this file's siblings
   * (`discussNote`, `creationPhaseNote`) are all placed to avoid.
   */
  it('sits past the last cache breakpoint', () => {
    const lastBreakpoint = PROXY.lastIndexOf('providerOptions: CACHE_CONTROL');
    const push = PROXY.indexOf('content: starterNote');

    expect(lastBreakpoint).toBeGreaterThan(-1);
    expect(push).toBeGreaterThan(lastBreakpoint);
  });

  /* CONTROLS — without these every assertion above passes against an empty or misread file. */
  it('CONTROL — the scanner is reading real files', () => {
    expect(PROXY.length).toBeGreaterThan(10_000);
    expect(PROXY).toContain('creationPhaseNote');
    expect(ROUTE).toContain('owesBuild: projectOwesBuild(');
  });

  it('CONTROL — the matcher can return false', () => {
    expect(PROXY).not.toMatch(/starterGameTypeNoteThatDoesNotExist/);
  });
});
