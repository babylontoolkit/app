/**
 * 🔴 THE PHASE RETRY IS WIRED — a source scan, because the decider being right proves nothing.
 *
 * `creation-plan-runner.spec.ts` proves `decideCreationPhaseRetry` answers correctly and is
 * mutation-verified five ways. That is exactly the state the §4.14 MCP relay was in before live
 * testing found three defects in it, and the state `creationPhaseMessage` was in for six days while
 * having no caller at all: **a pure function with no call site is a feature that is finished
 * everywhere except where it does something.**
 *
 * Every assertion here is one way this can be built correctly and still do nothing, silently — and
 * "silently" is literal: the symptom of each is a build that stops on a transient failure, which is
 * indistinguishable from the behaviour before the retry existed.
 *
 * ⚠️ A source scan can only see that the right names appear in the right places. It cannot see that
 * they run in the right ORDER, and it is not a substitute for driving a failing phase in a browser.
 * It is here because the alternative — no wiring check at all — is how this exact class of defect has
 * shipped repeatedly in this codebase.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const CHAT = readFileSync(join(process.cwd(), 'app/components/chat/Chat.client.tsx'), 'utf8');
const RUNNER = readFileSync(join(process.cwd(), 'app/lib/chat/creation-plan-runner.ts'), 'utf8');

describe('the retry reaches the code that starts a turn', () => {
  it('Chat.client imports and calls the decider', () => {
    expect(CHAT).toMatch(
      /import \{[\s\S]*?decideCreationPhaseRetry[\s\S]*?\} from '~\/lib\/chat\/creation-plan-runner'/,
    );
    expect(CHAT).toMatch(/decideCreationPhaseRetry\(\{/);
  });

  /**
   * 🔴 THE DEADLOCK. `useChat` keeps `error` set until the next request starts, so a re-armed phase
   * meets a decider that still sees `hasError` and pauses. The suppression exists precisely to break
   * that, and it only works if the CURRENT ref value is what gets passed — a captured render value is
   * the documented `projectId: undefined` post-mortem.
   */
  it('passes the live retry flag into the run decision, from the ref and not a render capture', () => {
    expect(CHAT).toMatch(/retrying:\s*retryingPhaseRef\.current/);
  });

  /**
   * 🔴 ONE-SHOT. Left set, a SECOND failure slips past the error pause and the plan retries forever —
   * a generation per failure on the user's bill, which is the runaway this whole runner is shaped to
   * prevent. Cleared where the phase is posted, next to the disarm that exists for the same reason.
   */
  it('clears the suppression when the phase is posted', () => {
    expect(CHAT).toMatch(/retryingPhaseRef\.current = false/);

    const disarm = CHAT.indexOf('armedPhaseRef.current = null;');
    const clear = CHAT.indexOf('retryingPhaseRef.current = false');
    expect(disarm).toBeGreaterThan(-1);
    expect(clear).toBeGreaterThan(disarm);
  });

  /**
   * The attempt count is per PHASE. Without the reset, one unlucky step spends the retry that a later
   * step is owed — so a build whose front end blipped would run its game step with no cover at all.
   */
  it('resets the attempt count when the plan advances', () => {
    const advance = CHAT.indexOf('const complete = isCreationPlanComplete(advanced);');
    expect(advance).toBeGreaterThan(-1);

    const after = CHAT.slice(advance, advance + 400);
    expect(after).toMatch(/phaseRetriesRef\.current = \{ index: -1, attempts: 0 \}/);
  });

  /**
   * 🔴 THE RETRY MUST RETURN BEFORE THE ERROR ALERT. It is announced by a toast — the user has nothing
   * to do and nothing has been lost — but a red "Request Failed" modal on a turn that is quietly
   * carrying on is the product contradicting itself on screen.
   *
   * ⚠️ This does NOT weaken fail-loud: the retry spends the one attempt, so a second failure reaches
   * the alert below with everything intact.
   */
  it('returns before raising the error alert', () => {
    const decision = CHAT.indexOf('decideCreationPhaseRetry({');
    const alert = CHAT.indexOf('setLlmErrorAlert({');
    expect(decision).toBeGreaterThan(-1);
    expect(alert).toBeGreaterThan(decision);

    expect(CHAT.slice(decision, alert)).toMatch(/return;/);
  });
});

describe('CONTROLS — the scanner is looking at real code', () => {
  /* Without this every assertion above passes vacuously against an empty or misread file. */
  it('reads the files it claims to', () => {
    expect(CHAT.length).toBeGreaterThan(10_000);
    expect(CHAT).toContain('decideNextCreationTurn');
    expect(RUNNER).toContain('export function decideCreationPhaseRetry');
  });

  /* A name this file would never legitimately find, proving the matcher can return false. */
  it('does not match something that is not there', () => {
    expect(CHAT).not.toMatch(/decideCreationPhaseRetryThatDoesNotExist/);
  });
});
