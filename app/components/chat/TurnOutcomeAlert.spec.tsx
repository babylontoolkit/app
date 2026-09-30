// @vitest-environment jsdom
/**
 * The outcome alert (D22): the button is labelled by the OUTCOME, and every state that stops short is
 * loud. The failure this pins is a paused or failing-check turn rendered as a quiet grey note with a
 * "Finish the build" button that posts the wrong instruction.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { TurnOutcomeAlert } from './TurnOutcomeAlert';
import {
  describeTurnOutcome,
  FIX_CHECK_MESSAGE,
  KEEP_BUILDING_MESSAGE,
  type TurnOutcome,
} from '~/lib/agent/turn-outcome';

afterEach(cleanup);

const facts = {
  isFirstBuildTurn: true,
  finishReason: 'stop',
  forcedContinuation: false,
  unproductiveRescue: false,
  completionPassWroteFiles: false,
  wroteFiles: true,
  aborted: false,
};

function renderAlert(outcome: TurnOutcome) {
  const postMessage = vi.fn();
  const clearAlert = vi.fn();
  render(<TurnOutcomeAlert outcome={outcome} postMessage={postMessage} clearAlert={clearAlert} />);

  return { postMessage, clearAlert };
}

describe('TurnOutcomeAlert', () => {
  it('paused: loud, labelled Keep building, posts KEEP_BUILDING_MESSAGE', () => {
    const { postMessage, clearAlert } = renderAlert(describeTurnOutcome({ ...facts, stopReason: 'budget' }));

    expect(screen.getByRole('alert')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Keep building' }));
    expect(postMessage).toHaveBeenCalledWith(KEEP_BUILDING_MESSAGE);
    expect(clearAlert).toHaveBeenCalled();
  });

  it('unverified: loud, labelled Fix the errors, posts FIX_CHECK_MESSAGE', () => {
    const { postMessage } = renderAlert(describeTurnOutcome({ ...facts, stopReason: 'breaker' }));

    expect(screen.getByRole('alert')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Fix the errors' }));
    expect(postMessage).toHaveBeenCalledWith(FIX_CHECK_MESSAGE);
  });

  it('legacy incomplete keeps Finish the build', () => {
    renderAlert(describeTurnOutcome({ ...facts, finishReason: 'length' }));

    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Finish the build' })).toBeInTheDocument();
  });

  /*
   * An outcome persisted in `agentMeta` before `actionLabel` existed reads back without it.
   */
  it('falls back to Finish the build when a persisted outcome has no actionLabel', () => {
    const legacy = { state: 'incomplete', headline: 'h', detail: 'd', action: 'go' } as unknown as TurnOutcome;
    renderAlert(legacy);

    expect(screen.getByRole('button', { name: 'Finish the build' })).toBeInTheDocument();
  });

  it('CONTROL: rescued is quiet and has no action button', () => {
    renderAlert(describeTurnOutcome({ ...facts, forcedContinuation: true }));

    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Dismiss']);
  });
});
