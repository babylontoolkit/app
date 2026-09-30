import { describe, expect, it } from 'vitest';
import { decideFolderGate, folderGateCopy, type FolderGateFacts, type FolderGateRequest } from './folder-gate';
import type { LocalProjectState } from './status';

const base: Omit<FolderGateFacts, 'state'> = {
  required: true,
  skippedThisSession: false,
  waitedTooLong: false,
};

const decide = (state: LocalProjectState, over: Partial<FolderGateFacts> = {}) =>
  decideFolderGate({ ...base, state, ...over });

describe('decideFolderGate — the workspace projects-folder gate (§4.5.4d)', () => {
  it('asks to choose a folder when this account has none on this machine', () => {
    expect(decide({ kind: 'unset' })).toBe('choose');
  });

  it('asks to reconnect when the folder is remembered but this session cannot reach it', () => {
    expect(decide({ kind: 'needs-permission', folderName: 'Projects' })).toBe('reconnect');
  });

  it('passes once connected', () => {
    expect(decide({ kind: 'connected', folderName: 'Projects' })).toBe('pass');
  });

  /* A gate that cannot be satisfied is a locked door, not a setup step. */
  it('passes a browser that cannot pick a folder (Safari, Firefox)', () => {
    expect(decide({ kind: 'unavailable' })).toBe('pass');
  });

  /* The folder handle is keyed by account, and the sign-in surface is behind any workspace. */
  it('passes a signed-out visitor', () => {
    expect(decide({ kind: 'signed-out' })).toBe('pass');
  });

  it('covers while the account is unknown, and lifts at the ceiling rather than trapping', () => {
    expect(decide({ kind: 'unknown' })).toBe('checking');
    expect(decide({ kind: 'unknown' }, { waitedTooLong: true })).toBe('pass');
  });

  describe('when the folder is not required', () => {
    it('still asks until the user says not now', () => {
      expect(decide({ kind: 'unset' }, { required: false })).toBe('choose');
      expect(decide({ kind: 'needs-permission', folderName: 'P' }, { required: false })).toBe('reconnect');
    });

    it('passes for the rest of the session after not now', () => {
      expect(decide({ kind: 'unset' }, { required: false, skippedThisSession: true })).toBe('pass');
      expect(decide({ kind: 'needs-permission', folderName: 'P' }, { required: false, skippedThisSession: true })).toBe(
        'pass',
      );
    });

    /* CONTROL: a recorded skip is not a back door — the flag alone cannot open a required gate. */
    it('CONTROL: a recorded skip is ignored while the folder is required', () => {
      expect(decide({ kind: 'unset' }, { required: true, skippedThisSession: true })).toBe('choose');
    });
  });
});

/*
 * 🔴 The gate is raised by the WORKSPACE DOORS (`workspace-gate.ts`), never by a route. A path list is
 * how it first shipped, and it put the question on the app builder's front page — before there was a
 * project for a folder to hold. This scan fails if one grows back.
 */
describe('the gate is not a route rule', () => {
  it('nothing in the module decides from a path', async () => {
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('./folder-gate.ts', import.meta.url), 'utf8'),
    );
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '');

    for (const banned of ['isGatedPath', 'pathname', 'useLocation', 'location.path']) {
      expect(code, `the gate must not consult ${banned}`).not.toContain(banned);
    }

    /* CONTROL: the scan reads real code, so "no matches" means something. */
    expect(code).toContain('decideFolderGate');
  });
});

describe('folderGateCopy — every string the gate shows', () => {
  const request = (over: Partial<FolderGateRequest> = {}): FolderGateRequest => ({
    gate: 'choose',
    intent: 'create',
    required: true,
    state: { kind: 'unset' },
    ...over,
  });

  /*
   * 🔴 Skip and cancel are OPPOSITE outcomes sharing one slot on screen — one opens the workspace with
   * no folder, the other abandons it — so exactly one may ever be offered.
   */
  it('offers Cancel when the folder is required and Not now when it is not, never both', () => {
    const required = folderGateCopy(request({ required: true }));
    expect(required.cancel).toBe('Cancel');
    expect(required.skip).toBeUndefined();

    const optional = folderGateCopy(request({ required: false }));
    expect(optional.skip).toBe('Not now');
    expect(optional.cancel).toBeUndefined();
  });

  it('names the intent, so the panel reads as part of the thing the user just asked for', () => {
    expect(folderGateCopy(request({ intent: 'create' })).detail).toContain('create this project');
    expect(folderGateCopy(request({ intent: 'open' })).detail).toContain('open this project');
  });

  it('tells a new user what the folder is for and that it can be changed later', () => {
    const copy = folderGateCopy(request());
    expect(copy.primary).toBe('Choose a folder on this computer');
    expect(copy.detail).toMatch(/Settings/);
    expect(copy.detail).toMatch(/GitHub/);
    expect(copy.detail).toContain('Apps are kept in its Apps folder and Unity projects in its Unity folder.');
    expect(copy.alternate).toBeUndefined();
  });

  it('names the remembered folder on reconnect and offers a different folder as the way out', () => {
    const copy = folderGateCopy(
      request({ gate: 'reconnect', state: { kind: 'needs-permission', folderName: 'BTK Projects' } }),
    );
    expect(copy.title).toBe('Reconnect BTK Projects');
    expect(copy.primary).toBe('Open BTK Projects');
    expect(copy.detail).toContain('BTK Projects');
    expect(copy.alternate).toBe('Use a different folder…');
  });

  it('the checking cover has no buttons at all', () => {
    const copy = folderGateCopy(request({ gate: 'checking', state: { kind: 'unknown' } }));
    expect(copy.primary).toBe('');
    expect(copy.skip).toBeUndefined();
    expect(copy.cancel).toBeUndefined();
    expect(copy.alternate).toBeUndefined();
  });
});
