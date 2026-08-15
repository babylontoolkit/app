/**
 * 🔴 A BLANK CANVAS PROJECT IS NEVER AUTO-BUILT (owner, 2026-08-14).
 *
 * *"If we are using the BLANK CANVAS options DO NOT AUTO create front end and artwork… all operations
 * from that point are just regular prompt turns. I can then use bt-landing when I want to create the
 * frontend."*
 *
 * ## The trap this file exists for
 *
 * The obvious implementation — "is this the Blank Canvas entry?" — is WRONG in the most expensive
 * possible direction. Genre inference was retired on 2026-08-04 (`decideSeed`), and since then **every
 * typed prompt seeds the Blank Canvas fallback row**. So `is_fallback` alone does not mean "the user
 * wanted an empty scene", it means "a prompt arrived" — and keying off it would have silently switched
 * the front-end and art phases OFF for every build, one day after they were made mandatory, with
 * nothing failing and nothing to see except games that quietly stopped getting a landing page.
 *
 * `seedSource` is the discriminator, and it exists because this exact conflation has already caused one
 * live defect: the chip reported "Started from: Blank Canvas" on a twin-stick-shooter prompt, which
 * reads as *we ignored what you asked for*.
 *
 * Every assertion here is mutation-verified.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isBlankCanvasStart } from './match';
import { projectOwesBuild } from '~/lib/agent/creation-plan';
import { newCreationPlan } from '~/lib/agent/creation-plan';

describe('isBlankCanvasStart — chosen, not landed on', () => {
  it('is TRUE only when the user explicitly picked the empty starter', () => {
    expect(isBlankCanvasStart({ isFallbackEntry: true, seedSource: 'explicit' })).toBe(true);
  });

  /**
   * 🔴 THE ONE THAT MATTERS. A typed prompt lands on the fallback row and must still be phased — this
   * is the case that would have disabled the front-end and art steps for every build in the product.
   */
  it('is FALSE for a typed prompt, which lands on the same fallback row', () => {
    expect(isBlankCanvasStart({ isFallbackEntry: true, seedSource: 'inferred' })).toBe(false);
  });

  /** An explicitly chosen GENRE is a request to build something — phases apply. */
  it('is FALSE for an explicitly chosen genre card', () => {
    expect(isBlankCanvasStart({ isFallbackEntry: false, seedSource: 'explicit' })).toBe(false);
  });

  it('is FALSE when the seed source is unknown', () => {
    expect(isBlankCanvasStart({ isFallbackEntry: true, seedSource: undefined })).toBe(false);
  });

  /**
   * ⚠️ BOTH halves are required, asserted as a truth table rather than by example. `seedSource`
   * defaults to `'explicit'` at its call site — correct for the chip, which must not attribute an
   * inference to the user — so a partial seed reaching this function reads as "chosen", and the entry
   * check is what stops that becoming "chosen the empty one".
   */
  it('needs BOTH halves — neither alone is the question', () => {
    const table = [
      [true, 'explicit', true],
      [true, 'inferred', false],
      [false, 'explicit', false],
      [false, 'inferred', false],
    ] as const;

    for (const [isFallbackEntry, seedSource, expected] of table) {
      expect(isBlankCanvasStart({ isFallbackEntry, seedSource }), `${isFallbackEntry} / ${seedSource}`).toBe(expected);
    }
  });
});

/**
 * 🔴 AND THE SERVER AGREES — a blank-canvas project owes no BUILD, so no turn on it is a first build.
 *
 * Answering `true` would keep all ten first-build protections on, including the forced `bt-landing` +
 * `bt-design` preload — which pushes the model toward the landing-page redesign this flag exists to
 * prevent, on every turn, for as long as the handoff exists.
 */
describe('projectOwesBuild — the blank canvas exemption', () => {
  it('a blank canvas handoff owes nothing, even with no plan', () => {
    expect(projectOwesBuild({ blankCanvas: true })).toBe(false);
    expect(projectOwesBuild({ blankCanvas: true, userPrompt: 'an empty scene' })).toBe(false);
  });

  /**
   * 🔴 THE ORDERING. A blank-canvas handoff has NO plan, so without the exemption being checked FIRST
   * it takes the "created, never built" branch — which is the most-owed answer there is, i.e. the exact
   * opposite of the intent.
   */
  it('CONTROL — the same handoff WITHOUT the flag owes a build', () => {
    expect(projectOwesBuild({})).toBe(true);
    expect(projectOwesBuild({ userPrompt: 'an empty scene' })).toBe(true);
  });

  /* An in-flight phased build is untouched — the exemption must not leak into the normal path. */
  it('CONTROL — a phased build still owes its remaining phases', () => {
    expect(projectOwesBuild({ plan: newCreationPlan() })).toBe(true);
  });

  /* Only the literal `true`: this decides whether the platform spends two turns on the user's behalf. */
  it('a non-boolean flag is not an exemption', () => {
    expect(projectOwesBuild({ blankCanvas: 1 as never })).toBe(true);
    expect(projectOwesBuild({ blankCanvas: 'yes' as never })).toBe(true);
  });
});

/**
 * 🔴 WIRED — a source scan, because the predicate being right proves nothing.
 *
 * `isBlankCanvasStart` is a pure function; it does nothing until something calls it at the one moment
 * both facts are in hand. That is the state `creationPhaseMessage` was in for six days while having no
 * caller, and the state the §4.14 relay was in before live testing found three defects in it.
 *
 * Each assertion below is one way this ships correct and inert, silently — and silently is literal: the
 * symptom is a Blank Canvas project that quietly builds a landing page anyway, which looks exactly like
 * the behaviour before this change.
 */
describe('the blank canvas flag reaches the code that decides', () => {
  const CHAT = readFileSync(join(process.cwd(), 'app/components/chat/Chat.client.tsx'), 'utf8');
  const MODE = readFileSync(join(process.cwd(), 'app/lib/stores/new-project-mode.ts'), 'utf8');
  const ROUTE = readFileSync(join(process.cwd(), 'app/routes/api.projects.$projectId.ts'), 'utf8');

  /** Recorded at creation — the only moment the entry AND the seed source are both in hand. */
  it('is decided at creation, from BOTH facts', () => {
    expect(CHAT).toMatch(/isBlankCanvasStart\(\{\s*isFallbackEntry:[\s\S]{0,80}seedSource/);
  });

  /**
   * 🔴 It must SURVIVE A RELOAD. `projectSeedStore` is in-memory and the send that reads this can
   * happen days later, on another device — so a flag that only lived in the creating tab would phase
   * the build anyway for anyone who closed it.
   */
  it('persists locally and on the project row', () => {
    expect(MODE).toMatch(/blankCanvas: mode\.blankCanvas/);
    expect(MODE).toMatch(/parsed\.blankCanvas === true/);
    expect(ROUTE).toMatch(/blankCanvas === true/);
  });

  /**
   * 🔴 THE SEND SKIPS THE PLAN. Without this the flag is recorded, read, and ignored: `newCreationPlan()`
   * runs, and the front-end and art phases post themselves exactly as before.
   */
  it('the send starts no plan for a blank canvas project', () => {
    const guard = CHAT.indexOf('newProjectMode.projectId && newProjectMode.blankCanvas');
    expect(guard, 'the blank-canvas branch must exist').toBeGreaterThan(-1);

    /*
     * ⚠️ Searched FORWARD from the guard, not from the top of the file: `newCreationPlan` also appears
     * in the import list, so an `indexOf` from zero compares a call site against an import and reports
     * the branches in the wrong order — green or red for reasons unrelated to what this asserts.
     */
    const rest = CHAT.slice(guard);
    const elseAt = rest.indexOf('} else if (newProjectMode.projectId) {');
    expect(elseAt, 'the phased branch must still be there for every other project').toBeGreaterThan(-1);

    expect(rest.slice(0, elseAt), 'the blank-canvas branch must NOT start a plan').not.toMatch(/newCreationPlan\(/);
    expect(rest.slice(elseAt, elseAt + 600), 'and the phased branch must still start one').toMatch(/newCreationPlan\(/);
  });

  /**
   * The handoff is CLEARED on that send, restoring the pre-phase behaviour for this one path. Left in
   * place the card would keep offering to build a project that has been built.
   */
  it('clears the handoff on the send instead', () => {
    const guard = CHAT.indexOf('newProjectMode.projectId && newProjectMode.blankCanvas');
    const after = CHAT.slice(guard, guard + 600);

    expect(after).toMatch(/exitNewProjectMode\(newProjectMode\.projectId\)/);
    expect(after).toMatch(/saveCreationHandoff\(newProjectMode\.projectId, null\)/);
  });

  /* CONTROLS — without these every assertion above passes against an empty or misread file. */
  it('CONTROL — the scanner is reading real files', () => {
    expect(CHAT.length).toBeGreaterThan(10_000);
    expect(CHAT).toContain('newCreationPlan');
    expect(MODE).toContain('readNewProjectMode');
    expect(ROUTE).toContain('parseCreationHandoff');
  });

  it('CONTROL — the matcher can return false', () => {
    expect(CHAT).not.toMatch(/isBlankCanvasStartThatDoesNotExist/);
  });
});
