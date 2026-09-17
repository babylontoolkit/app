import { describe, expect, it } from 'vitest';
import { describeLocalProject, type LocalProjectState } from './status';

describe('describeLocalProject — every string the disk-link surfaces show', () => {
  it('offers exactly one action per state, and none where nothing can be done', () => {
    const cases: Array<[LocalProjectState, string | undefined]> = [
      [{ kind: 'unknown' }, undefined],
      [{ kind: 'signed-out' }, undefined],
      [{ kind: 'unavailable' }, undefined],
      [{ kind: 'unset' }, 'choose'],
      [{ kind: 'needs-permission', folderName: 'Projects' }, 'reconnect'],
      [{ kind: 'connected', folderName: 'Projects' }, 'change'],
      [{ kind: 'connected', folderName: 'Projects', project: { dirName: 'kart', pending: 0 } }, 'change'],
    ];

    for (const [state, action] of cases) {
      expect(describeLocalProject(state).action).toBe(action);
    }
  });

  it('names the folder and the project folder once connected', () => {
    const view = describeLocalProject({
      kind: 'connected',
      folderName: 'Projects',
      project: { dirName: 'kart', pending: 0 },
    });
    expect(view.headline).toBe('Projects/kart');
    expect(view.tone).toBe('quiet');
  });

  it('surfaces a write error verbatim and loudly', () => {
    const view = describeLocalProject({
      kind: 'connected',
      folderName: 'Projects',
      project: { dirName: 'kart', pending: 0, error: 'src/a.ts: disk full' },
    });
    expect(view.tone).toBe('error');
    expect(view.detail).toContain('disk full');
  });

  it('counts pending writes', () => {
    expect(
      describeLocalProject({ kind: 'connected', folderName: 'P', project: { dirName: 'k', pending: 1 } }).detail,
    ).toBe('Writing 1 file to disk…');
    expect(
      describeLocalProject({ kind: 'connected', folderName: 'P', project: { dirName: 'k', pending: 3 } }).detail,
    ).toBe('Writing 3 files to disk…');
  });

  it('says it is unavailable rather than offering a control that cannot work (Safari, Firefox)', () => {
    const view = describeLocalProject({ kind: 'unavailable' });
    expect(view.action).toBeUndefined();
    expect(view.detail).toMatch(/Not available in this browser/);
  });
});
