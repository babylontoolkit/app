/**
 * The user must be told WHY no project was created (SPEC §4.4).
 *
 * These are assertions about wording, which normally would not earn a test — except that the wording
 * is the whole feature here. The message this replaced said *"Could not fetch the starter template
 * (401)"*, which is wrong in the way that costs the most: a 401 from `/api/starter-template` is an
 * expired SESSION, the starter template is fine, and the user retries a button that cannot work until
 * they sign in. So each case pins the two things that make a message actionable — that it points at
 * the real subsystem, and that `isRetryable` does not invite a pointless retry.
 */
import { describe, it, expect } from 'vitest';
import {
  CreationError,
  asCreationFailure,
  describeMountFailure,
  describeStarterFetchFailure,
  describeStarterPayloadFailure,
  describeStarterTransportFailure,
  formatCreationFailure,
} from './creation-errors';

describe('describeStarterFetchFailure', () => {
  it('blames the SESSION on a 401, not the template, and does not invite a retry', () => {
    const failure = describeStarterFetchFailure({ status: 401, body: { message: 'Not signed in' } });

    expect(failure.message).toMatch(/session/i);
    expect(failure.message).toMatch(/sign in/i);
    expect(failure.isRetryable).toBe(false);
    expect(failure.detail).toContain('401');
    expect(failure.detail).toContain('Not signed in');
  });

  it('treats a 403 the same as a 401 — both mean the wall refused, not the template', () => {
    expect(describeStarterFetchFailure({ status: 403 }).message).toMatch(/session/i);
  });

  it('names a mid-deploy 404 rather than implying the template is missing', () => {
    const failure = describeStarterFetchFailure({ status: 404 });

    expect(failure.message).toMatch(/mid-deploy|not found/i);
    expect(failure.isRetryable).toBe(true);
  });

  it('points a 5xx at the admin PIN, which is the only thing that actually fixes it', () => {
    const failure = describeStarterFetchFailure({
      status: 500,
      body: { error: 'Failed to fetch template files', details: 'GitHub 404 for babylontoolkit/AppTemplate' },
    });

    // The server only 500s here after the pin AND the last-known-good snapshot both came up empty.
    expect(failure.message).toMatch(/Admin/);
    expect(failure.message).toMatch(/pinned/i);

    // The server's own reason survives verbatim — that is what makes a screenshot debuggable.
    expect(failure.detail).toContain('GitHub 404 for babylontoolkit/AppTemplate');
  });

  it('is still specific about the STATUS when the body is not JSON at all', () => {
    const failure = describeStarterFetchFailure({ status: 502, statusText: 'Bad Gateway', body: undefined });

    expect(failure.detail).toContain('502');
    expect(failure.detail).toContain('Bad Gateway');
  });

  it('never leaks the `error: true` flag from errorResponse as if it were a reason', () => {
    const failure = describeStarterFetchFailure({ status: 500, body: { error: true, message: 'Server error' } });

    expect(failure.detail).toContain('Server error');
    expect(failure.detail).not.toContain('true');
  });
});

describe('the other fatal steps', () => {
  it('says the request never completed, rather than blaming the template', () => {
    const failure = describeStarterTransportFailure(new TypeError('Failed to fetch'));

    expect(failure.message).toMatch(/could not reach the server/i);
    expect(failure.detail).toContain('Failed to fetch');
  });

  it('distinguishes an empty 200 from a failed request', () => {
    expect(describeStarterPayloadFailure([]).detail).toContain('empty list');
    expect(describeStarterPayloadFailure({ error: 'nope' }).detail).toContain('object');
  });

  it('attributes a mount failure to the WRITE and preserves the specific message', () => {
    const failure = describeMountFailure(
      new Error('Failed to mount template asset "public/havok.wasm" — the project would be missing assets.'),
    );

    expect(failure.message).toMatch(/could not be written/i);
    expect(failure.detail).toContain('public/havok.wasm');
  });
});

describe('CreationError', () => {
  it('carries the classification so the catch site never has to re-guess it from English', () => {
    const failure = describeStarterFetchFailure({ status: 401 });
    const error = new CreationError(failure);

    expect(asCreationFailure(error)).toBe(failure);
    expect(error.message).toBe(formatCreationFailure(failure));
  });

  it('classifies an unexpected throw as itself rather than swallowing it', () => {
    const failure = asCreationFailure(new Error('scaffoldGameMode is not a function'));

    expect(failure.detail).toContain('scaffoldGameMode is not a function');
    expect(failure.message).toMatch(/could not be created/i);
  });
});
