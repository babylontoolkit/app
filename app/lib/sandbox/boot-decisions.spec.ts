/**
 * The pure decisions a project-scoped boot makes (SPEC §8, `spec/sandbox-codesandbox.md`).
 *
 * Every rule here is one that throws nothing when it is wrong:
 *
 *   - a session body without its project id is a 400 the user reads as "the workspace is broken";
 *   - a preview minted for the wrong project hands a live, readable iframe of somebody else's game
 *     to this page, with no error anywhere;
 *   - a reconnect that ADOPTS a different sandbox swaps the filesystem under a running workbench —
 *     every file gone, no event, the tree still rendering from memory;
 *   - a sentinel verdict that answers `mismatch` where it should answer `unknown` sends every warm
 *     VM that predates the sentinel down the restore-from-a-client-copy path the gate exists to
 *     avoid, which is the MEASURED bug (a stale working copy reverting a generated landing page).
 *
 * `describeSandboxFailure` lives in `errors.ts` but is tested here on purpose: it is the same pure
 * boot-decision surface — the function that decides what a person is told when a boot dies — and its
 * three-line contract does not warrant a file of its own.
 */
import { describe, expect, it } from 'vitest';
import {
  assertReconnectSameSandbox,
  identitySentinel,
  previewCacheIsFresh,
  previewRequestPath,
  readIdentityVerdict,
  SANDBOX_IDENTITY_DIR,
  SANDBOX_IDENTITY_PATH,
  sessionRequestBody,
} from './boot-decisions';
import {
  describeSandboxFailure,
  SandboxAdoptionError,
  SandboxProjectMismatchError,
  SandboxUnavailableError,
} from './errors';

describe('sessionRequestBody — the project id is the whole point of the request', () => {
  /*
   * 🔴 The pre-per-project client posted `{}` here. The route's second wall is `requireOwnedProject`,
   * so a body with no project id is a 400 before anything can happen — and the symptom is an empty
   * workbench, not a message about a missing field. This is the assertion that keeps the shape a
   * tested fact rather than an inline object literal nobody re-reads.
   */
  it('carries the project id', () => {
    expect(sessionRequestBody('prj_a')).toEqual({ projectId: 'prj_a' });
  });

  /*
   * `reset` is a DESTRUCTIVE flag (it wipes the VM's disk). Present-only-when-asked means an ordinary
   * resume can never carry it by accident through an options object that was spread from somewhere
   * else.
   */
  it('omits reset unless it was explicitly requested', () => {
    expect(sessionRequestBody('prj_a', {})).not.toHaveProperty('reset');
    expect(sessionRequestBody('prj_a', { reset: false })).not.toHaveProperty('reset');
    expect(sessionRequestBody('prj_a', { reset: true })).toEqual({ projectId: 'prj_a', reset: true });
  });
});

describe('previewRequestPath — a preview is minted for ONE project', () => {
  /*
   * 🔴 Both parameters are required by the route, and the project id is what stops port 5173 of
   * project B being answered with the token minted for port 5173 of project A. A sandbox is
   * `privacy: 'private'`, so that token IS the access — handing over the wrong one is a working
   * preview of the wrong (unreleased) game.
   */
  it('names both the port and the project', () => {
    const path = previewRequestPath('prj_a', 5173);

    expect(path).toContain('port=5173');
    expect(path).toContain('projectId=prj_a');
  });

  it('encodes both, so an id with URL syntax in it cannot smuggle another parameter', () => {
    const path = previewRequestPath('prj/a&port=1', 5173);

    expect(path).toContain('projectId=prj%2Fa%26port%3D1');
    expect(path.match(/[?&]port=/g)).toHaveLength(1);
  });
});

describe('assertReconnectSameSandbox — the refusal that prevents a silent filesystem swap', () => {
  it('allows the ordinary case: the same sandbox, not newly created', () => {
    expect(() => assertReconnectSameSandbox('sb_1', { sandboxId: 'sb_1', created: false })).not.toThrow();
    expect(() => assertReconnectSameSandbox('sb_1', { sandboxId: 'sb_1' })).not.toThrow();
  });

  /*
   * 🔴 `created` is checked SEPARATELY from the id, and the same-id case is the one that would be
   * missed by an id-only check. If the server had to CREATE the VM, the disk is bare template state
   * even when the id it reports happens to match — reconnecting silently would put a live client onto
   * an empty filesystem mid-session while the workbench keeps rendering the old tree.
   */
  it('refuses a session the server had to CREATE, even under the same id', () => {
    expect(() => assertReconnectSameSandbox('sb_1', { sandboxId: 'sb_1', created: true })).toThrow(
      SandboxAdoptionError,
    );
  });

  it('refuses a DIFFERENT sandbox even when the server says it did not create it', () => {
    expect(() => assertReconnectSameSandbox('sb_1', { sandboxId: 'sb_2', created: false })).toThrow(
      SandboxAdoptionError,
    );
  });

  /** The error names both ids, because "your workspace was replaced" is unactionable without them. */
  it('reports which sandbox was booted and which was offered', () => {
    try {
      assertReconnectSameSandbox('sb_1', { sandboxId: 'sb_2' });
      expect.unreachable('a differing sandbox id must throw');
    } catch (error) {
      expect((error as SandboxAdoptionError).bootedSandboxId).toBe('sb_1');
      expect((error as SandboxAdoptionError).offeredSandboxId).toBe('sb_2');
    }
  });
});

describe('the project sentinel — three answers, not two', () => {
  it('round-trips: what is written is what is read back as a match', () => {
    expect(readIdentityVerdict(identitySentinel('prj_a'), 'prj_a')).toBe('match');
  });

  /*
   * 🔴 The ONLY case that closes the warm-boot gate. It exists to catch a mis-pointed `sandbox_id` —
   * an operator edit, a restored old row, a compare-and-set that lost — whose consequence is one
   * project's files becoming another project's truth and then being pushed to that project's repo.
   */
  it('is a mismatch only when a sentinel is PRESENT and names someone else', () => {
    expect(readIdentityVerdict(identitySentinel('prj_b'), 'prj_a')).toBe('mismatch');
  });

  /*
   * 🔴 Everything unreadable is `unknown`, never `mismatch`. A sandbox created before the sentinel
   * existed — or one whose `.codesandbox/` was cleaned — makes no claim, and treating "no claim" as
   * "wrong project" would send every warm VM in existence down the restore path, silently reverting
   * live work to a client copy. Absent, empty, corrupt, wrong-typed and blank all mean the same
   * thing: nothing to act on.
   */
  it.each([
    ['absent', undefined],
    ['empty', ''],
    ['not JSON at all', 'half a file'],
    ['truncated JSON', '{"projectId": "prj_'],
    ['JSON without the field', '{}'],
    ['a non-string project id', '{"projectId": 17}'],
    ['a blank project id', '{"projectId": ""}'],
  ])('answers unknown for a sentinel that is %s', (_label, raw) => {
    expect(readIdentityVerdict(raw, 'prj_a')).toBe('unknown');
  });

  /*
   * The sentinel lives inside `.codesandbox/` — the directory T9 excludes from the file map, so that
   * once T9 lands it never reaches the model's context (§4.2.8), an export, or a push to the user's
   * repository. ⚠️ T9 has not shipped: today the file IS in the map, which the plan accepted as
   * harmless. Pinned anyway, because the exclusion is by DIRECTORY — a path that drifted out of it
   * would silently opt back out of T9 and start billing on every turn.
   */
  it('lives inside the .codesandbox directory T9 excludes', () => {
    expect(SANDBOX_IDENTITY_PATH.startsWith(`${SANDBOX_IDENTITY_DIR}/`)).toBe(true);
  });

  it('writes parseable JSON with a trailing newline', () => {
    const bytes = identitySentinel('prj_a');

    expect(bytes.endsWith('\n')).toBe(true);
    expect(JSON.parse(bytes)).toEqual({ projectId: 'prj_a' });
  });
});

describe('previewCacheIsFresh — never hand an iframe a token about to die', () => {
  const WINDOW = 5 * 60_000;

  it('is fresh while more than the re-mint window remains', () => {
    expect(previewCacheIsFresh(10_000_000, 10_000_000 - WINDOW - 1, WINDOW)).toBe(true);
  });

  /*
   * The boundary is exclusive on purpose: exactly-the-window-left is treated as stale, because the
   * cost of an extra mint is one request and the cost of being wrong is an iframe that 401s a few
   * seconds after it renders — which reads as "the preview is broken", not as an expiry.
   */
  it('is stale at the boundary and past it, including an already-expired token', () => {
    expect(previewCacheIsFresh(10_000_000, 10_000_000 - WINDOW, WINDOW)).toBe(false);
    expect(previewCacheIsFresh(10_000_000, 10_000_001, WINDOW)).toBe(false);
  });
});

describe('describeSandboxFailure — what replaces the whole screen, and what does not', () => {
  /*
   * `retryable` is carried through rather than assumed. The server marks a provider blip 503 and a
   * rate limit 429 as retryable, while "not your project" and "no project id" are states a retry
   * cannot change — and a retry button for those is a lie the user will press repeatedly.
   */
  it('passes a sandbox outage through with its own retryability', () => {
    expect(describeSandboxFailure(new SandboxUnavailableError('Could not reach the provider.'))).toEqual({
      message: 'Could not reach the provider.',
      retryable: true,
    });
    expect(
      describeSandboxFailure(new SandboxUnavailableError('Sandbox provider is not configured.', { retryable: false })),
    ).toEqual({ message: 'Sandbox provider is not configured.', retryable: false });
  });

  /*
   * 🔴 Neither of these is retryable IN PLACE, whatever a caller might hope: both mean this tab is
   * bound to a sandbox that is not the one being asked for, and no amount of retrying re-points the
   * stores that already captured the seam's single promise. A reload is the honest instruction, and
   * it is in the message.
   */
  it('marks a mismatch and an adoption refusal as unretryable, and says reload', () => {
    for (const error of [new SandboxProjectMismatchError('prj_a', 'prj_b'), new SandboxAdoptionError('sb_1', 'sb_2')]) {
      const described = describeSandboxFailure(error);

      expect(described?.retryable).toBe(false);
      expect(described?.message.toLowerCase()).toContain('reload');
    }
  });

  /*
   * 🔴 The other direction is what keeps the boot screen honest. A mount can fail for a dozen reasons
   * — a repo fetch, IndexedDB, a bad checkpoint — and most leave a perfectly usable workbench. Those
   * must keep landing on the "warn and carry on" path; replacing the screen for them would hide a
   * working product behind a failure surface.
   */
  it('does not claim an ordinary failure is a sandbox failure', () => {
    expect(describeSandboxFailure(new Error('repo fetch failed'))).toBeUndefined();
    expect(describeSandboxFailure(new TypeError('undefined is not a function'))).toBeUndefined();
    expect(describeSandboxFailure('a string')).toBeUndefined();
    expect(describeSandboxFailure(undefined)).toBeUndefined();
  });
});
