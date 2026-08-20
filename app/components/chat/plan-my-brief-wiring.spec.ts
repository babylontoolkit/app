/**
 * 🔴 "PLAN MY BRIEF" MUST NOT ARM THE THREE-STAGE BUILD (owner, 2026-08-15).
 *
 * *"when you hit the `Plan my brief` it should NOT use the three stages card and try the multi stage
 * build, [it should] use a skill, like `/bt-plan`, because they chose the `Plan my brief` button."*
 *
 * The button dismisses the handoff card, sets `chatMode: 'discuss'` and fills the composer with
 * `/bt-plan <brief>` WITHOUT sending — the user presses enter themselves. That send therefore runs
 * the ordinary `sendMessage`, and `sendMessage`'s `if (newProjectMode)` block arms a phased creation
 * plan (`newCreationPlan()` → `updateCreationPlan` → `saveCreationHandoff({ plan })`) for ANY first
 * send out of New Project mode except Blank Canvas. So a turn the user explicitly asked to PLAN
 * starts the §4.4e multi-stage build instead, `CreationPlanCard` appears, and `phaseTurnRef` /
 * `creationCompleteRef` are armed for phases that will never run the way the plan turn expects.
 *
 * Setting the mode is what makes the button real (a `/bt-plan` prefix without `chatMode: 'discuss'`
 * is a request the pipeline is free to ignore) — and it is also the fact this block never reads. The
 * mode is committed React state by the time the user presses enter, so the information is right
 * there; nothing consults it.
 *
 * ## Why a SOURCE scan
 *
 * `sendMessage` is a closure inside `ChatImpl` with no seam that returns its decisions, in the shape
 * `phase-retry-wiring.spec.ts` and `first-build-turn.spec.ts` already use for exactly this reason:
 * comment-stripped, scoped to the one block by brace matching, and every extraction proven to have
 * found the real code BEFORE anything is asserted about it — a scan that silently matches nothing
 * reports all-clear forever.
 *
 * ⚠️ A source scan can see that the right names appear in the right place. It cannot see that the
 * gate is evaluated correctly, and it is not a substitute for pressing the button in a browser. It
 * is here because the alternative — no wiring check at all — is how this class of defect has shipped
 * repeatedly in this codebase.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const RAW = readFileSync(join(process.cwd(), 'app/components/chat/Chat.client.tsx'), 'utf8');

/**
 * Comments are documentation, not behaviour, and here that is load-bearing in both directions: the
 * block under test carries several hundred words of doc comment that DISCUSS the mode, the brief and
 * the plan in prose. An unstripped scan would find every rule "wired" from the commentary alone —
 * precisely the false all-clear this file exists to prevent.
 */
const CHAT = RAW.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** Brace-match the body of a `{ … }` that opens at or after `from`. */
function block(source: string, from: number): string {
  const open = source.indexOf('{', from);

  if (open === -1) {
    return '';
  }

  let depth = 0;

  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') {
      depth++;
    } else if (source[i] === '}' && --depth === 0) {
      return source.slice(open, i + 1);
    }
  }

  return '';
}

/** The real `sendMessage` handler — every rule below is about where something sits inside it. */
const SEND_MESSAGE = block(CHAT, CHAT.indexOf('const sendMessage = async'));

/**
 * The creation-plan arming: from the `newProjectMode` derivation through the end of the
 * `if (newProjectMode) { … }` block that starts the plan. This is the whole decision — the gate may
 * legitimately live on the `if` condition or on a flag computed a line above it, so the region is
 * scoped to include both rather than to a single expression.
 */
const ARMING = (() => {
  const start = SEND_MESSAGE.indexOf('const storedMode = newProjectModeStore.get()');

  if (start === -1) {
    return '';
  }

  const gate = SEND_MESSAGE.indexOf('if (newProjectMode', start);

  return SEND_MESSAGE.slice(start, gate === -1 ? start : gate + block(SEND_MESSAGE, gate).length + 20);
})();

describe('CONTROLS — the scanner is looking at the real code', () => {
  /* Without these, every assertion below passes vacuously against an empty or misread extraction. */
  it('reads the file it claims to', () => {
    expect(RAW.length).toBeGreaterThan(10_000);
    expect(CHAT).toContain('const sendMessage = async');
  });

  it('found the real sendMessage handler', () => {
    expect(SEND_MESSAGE.length).toBeGreaterThan(1_000);
    expect(SEND_MESSAGE).toContain('newProjectModeStore.get()');
  });

  /* The extraction really is the plan arming — all three of its writes are inside it. */
  it('found the creation-plan arming inside it', () => {
    expect(ARMING).toContain('newCreationPlan()');
    expect(ARMING).toContain('updateCreationPlan(');
    expect(ARMING).toContain('saveCreationHandoff(');
    expect(ARMING.length).toBeLessThan(SEND_MESSAGE.length);
  });

  /* A name this file would never legitimately find, proving the matchers can return false. */
  it('does not match something that is not there', () => {
    expect(ARMING).not.toMatch(/newCreationPlanThatDoesNotExist/);
  });
});

describe('the creation-plan arming is gated on the turn not being a Plan turn', () => {
  /**
   * 🔴 `sendMessage` must READ the mode at all. Today the word does not appear anywhere in the
   * comment-stripped handler: the chat's Build/Plan state is committed React state that this code
   * path simply never consults, which is why the button's mode switch reaches the server and changes
   * nothing about what the client arms.
   */
  it('sendMessage consults the chat mode', () => {
    expect(SEND_MESSAGE).toMatch(/chatMode|isPlanTurn|planTurn|discuss/i);
  });

  /**
   * 🔴 And the arming ITSELF must be the thing guarded — not merely somewhere in the same function.
   *
   * The narrower rule matters because the block has three branches and only one of them starts a
   * plan; a gate placed after the fact (say, on `phaseId`) would leave `updateCreationPlan` and the
   * `saveCreationHandoff({ plan })` PATCH already sent, so the row would owe a phased build that the
   * user never asked for and a later reload would resume it.
   */
  /**
   * ⚠️ Asserted on the `if` CONDITION, not on the region.
   *
   * The first draft of this test was `expect(ARMING).toMatch(/chatMode|isPlanTurn|discuss/i)`, and
   * mutation testing found it vacuous: the fix declares `const isPlanTurn = chatMode === 'discuss'`
   * immediately above the `if`, inside the extracted region, so reverting the guard to
   * `if (newProjectMode) {` left the word `isPlanTurn` sitting in the region and the assertion passed
   * against the exact bug it is named for. A scan that proves a WORD is present proves nothing about
   * whether it is USED — and this repo has now recorded that shape three times in one session.
   */
  it('the arming block is guarded by it', () => {
    const condition = ARMING.slice(
      ARMING.indexOf('if (newProjectMode'),
      ARMING.indexOf(') {', ARMING.indexOf('if (newProjectMode')),
    );

    // The extraction itself must be real, or `toMatch` below is asserting against an empty string.
    expect(condition).toContain('newProjectMode');
    expect(condition.length).toBeLessThan(120);

    expect(condition).toMatch(/chatMode|isPlanTurn|planTurn|discuss/i);
  });

  /**
   * CONTROL — the ordinary phased build must still be armed. Without this, deleting the arming
   * outright passes both assertions above, and every ordinary creation silently loses its front-end,
   * art and game phases: the §4.4e monolithic-creation failure the plan exists to prevent.
   */
  it('CONTROL: an ordinary build send still starts a plan', () => {
    expect(ARMING).toContain('newCreationPlan()');
    expect(ARMING).toMatch(/updateCreationPlan\(newProjectMode\.projectId, plan\)/);
  });
});
