/**
 * `describeTurnOutcome` — the user-visible half of the fail-loud corollary.
 *
 * The failure this prevents is a SUCCESS message on a broken build: a real creation finished
 * `length+forced-continuation`, cut off mid-project, billed 1,175 credits, and showed
 * `🎮 Your game is ready`. Every branch is pinned, and the `finished` branch is pinned hardest —
 * a warning that fires on healthy builds is one the user learns to ignore.
 */
import { describe, expect, it } from 'vitest';
import { describeTurnOutcome, FINISH_BUILD_MESSAGE, type TurnOutcomeFacts } from './turn-outcome';

const clean: TurnOutcomeFacts = {
  isFirstBuildTurn: true,
  finishReason: 'stop',
  forcedContinuation: false,
  unproductiveRescue: false,
  completionPassWroteFiles: false,
  wroteFiles: true,
  aborted: false,
};

describe('a clean build says nothing', () => {
  /*
   * The most important test here. Every other branch is a warning, and a warning that appears on
   * ordinary successful builds is worthless on the turn that matters.
   */
  it('reports finished for an ordinary successful creation', () => {
    expect(describeTurnOutcome(clean).state).toBe('finished');
  });

  it('says nothing on an ordinary (non-creation) turn, whatever happened', () => {
    const outcome = describeTurnOutcome({
      ...clean,
      isFirstBuildTurn: false,
      finishReason: 'length',
      forcedContinuation: true,
      wroteFiles: false,
    });

    expect(outcome.state).toBe('finished');
  });

  /*
   * A Stop is the user's own decision, charged for what it consumed (`fail-loud.md` state 4). Telling
   * someone their build did not finish after they stopped it is noise.
   */
  it('says nothing when the user pressed Stop', () => {
    expect(describeTurnOutcome({ ...clean, aborted: true, finishReason: 'length' }).state).toBe('finished');
  });
});

describe('a truncated build is LOUD', () => {
  /*
   * 🔴 THE MEASURED FAILURE. finish=length means the provider stopped at the output ceiling, so the
   * last thing written ends mid-token. This exact turn showed a celebration toast.
   */
  it('reports incomplete when the output ceiling cut the reply off', () => {
    const outcome = describeTurnOutcome({ ...clean, finishReason: 'length' });

    expect(outcome.state).toBe('incomplete');
    expect(outcome.headline).toMatch(/did not finish/i);
    expect(outcome.action).toBe(FINISH_BUILD_MESSAGE);
  });

  /*
   * 🔴 INCOMPLETE OUTRANKS RESCUED. A truncated turn that was ALSO rescued is still truncated, and
   * reporting the rescue would describe the treatment while hiding the injury. This is the exact
   * combination the live run produced: `length+forced-continuation`.
   */
  it('reports incomplete, not rescued, when a truncated turn was also continued', () => {
    const outcome = describeTurnOutcome({
      ...clean,
      finishReason: 'length',
      forcedContinuation: true,
      completionPassWroteFiles: true,
    });

    expect(outcome.state).toBe('incomplete');
  });

  it('reports incomplete when a creation wrote no files at all', () => {
    const outcome = describeTurnOutcome({ ...clean, wroteFiles: false });

    expect(outcome.state).toBe('incomplete');
    expect(outcome.action).toBe(FINISH_BUILD_MESSAGE);
  });

  /*
   * The detail has to say what it means for THEIR project — "an error occurred" sends someone hunting.
   * It must name the surfaces most likely missing, because those are the ones written last.
   */
  it('names what is likely missing rather than just reporting an error', () => {
    const outcome = describeTurnOutcome({ ...clean, finishReason: 'length' });

    expect(outcome.detail).toMatch(/landing page/i);
    expect(outcome.detail).toMatch(/chrome/i);
  });

  /*
   * Fail-loud rule: never leave a dead end. Every incomplete state carries something the user can do.
   */
  it('always offers an action on an incomplete build', () => {
    for (const facts of [
      { ...clean, finishReason: 'length' },
      { ...clean, wroteFiles: false },
    ]) {
      expect(describeTurnOutcome(facts).action).toBeTruthy();
    }
  });
});

describe('a rescued build is reported quietly', () => {
  /*
   * `fail-loud.md` reporting corollary: an automatic transition on a paid path must be user-visible
   * when the outcome differed from what was asked for. The project IS complete here, so this is a
   * note, not an alarm — and it carries no action, because there is nothing to do.
   */
  it('reports rescued when the completeness pass had to write files', () => {
    const outcome = describeTurnOutcome({ ...clean, completionPassWroteFiles: true });

    expect(outcome.state).toBe('rescued');
    expect(outcome.headline).toMatch(/ready/i);
    expect(outcome.action).toBeNull();
  });

  it('reports rescued after a forced continuation', () => {
    expect(describeTurnOutcome({ ...clean, forcedContinuation: true }).state).toBe('rescued');
  });

  it('reports rescued after an unproductive-turn rescue', () => {
    expect(describeTurnOutcome({ ...clean, unproductiveRescue: true }).state).toBe('rescued');
  });

  /*
   * The CONTROL. Without it, "a rescue is reported" passes for a function that reports EVERY build as
   * rescued — which is the ignore-it-forever failure mode.
   */
  it('CONTROL: a build with no intervention is not reported as rescued', () => {
    expect(describeTurnOutcome(clean).state).not.toBe('rescued');
  });
});

describe('the action message', () => {
  /*
   * It must say CONTINUE, never start over: the files already written are correct, and re-emitting
   * them costs a second creation's worth of output at 5x the input rate.
   */
  it('tells the model to continue rather than restart', () => {
    expect(FINISH_BUILD_MESSAGE).toMatch(/continue from exactly where you stopped/i);
    expect(FINISH_BUILD_MESSAGE).toMatch(/do not start over/i);
    expect(FINISH_BUILD_MESSAGE).toMatch(/do not rewrite files that are already correct/i);
  });
});
