import { beforeEach, describe, expect, it } from 'vitest';
import {
  beginWorkspaceCheck,
  CHECK_WINDOW_GRACE_MS,
  endWorkspaceCheck,
  isWorkspaceCheckInProgress,
  resetWorkspaceCheckWindow,
  suppressesPreviewAlert,
} from './check-window';

describe('workspace check window', () => {
  beforeEach(() => resetWorkspaceCheckWindow());

  it('suppresses nothing when no check has run', () => {
    expect(isWorkspaceCheckInProgress()).toBe(false);
    expect(suppressesPreviewAlert(Date.now())).toBe(false);
  });

  it('suppresses while a check runs, and for the grace window after it ends', () => {
    beginWorkspaceCheck();
    expect(suppressesPreviewAlert(123)).toBe(true);

    endWorkspaceCheck(10_000);
    expect(isWorkspaceCheckInProgress()).toBe(false);
    expect(suppressesPreviewAlert(10_000 + CHECK_WINDOW_GRACE_MS)).toBe(true);
    expect(suppressesPreviewAlert(10_000 + CHECK_WINDOW_GRACE_MS + 1)).toBe(false);
  });

  it('overlapping checks: the window stays open until the LAST one ends', () => {
    beginWorkspaceCheck();
    beginWorkspaceCheck();
    endWorkspaceCheck(5_000);
    expect(isWorkspaceCheckInProgress()).toBe(true);

    endWorkspaceCheck(6_000);
    expect(isWorkspaceCheckInProgress()).toBe(false);
  });

  it('an unbalanced end never goes negative', () => {
    endWorkspaceCheck(1);
    beginWorkspaceCheck();
    expect(isWorkspaceCheckInProgress()).toBe(true);
  });
});
