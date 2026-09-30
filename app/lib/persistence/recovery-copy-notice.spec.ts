import { beforeEach, describe, expect, it, vi } from 'vitest';

const warn = vi.fn();

vi.mock('react-toastify', () => ({ toast: { warn: (...args: unknown[]) => warn(...args) } }));

import {
  notifyRecoveryCopySkipped,
  RECOVERY_COPY_SKIPPED_MESSAGE,
  resetRecoveryCopyNoticeForTests,
} from './recovery-copy-notice';

beforeEach(() => {
  warn.mockClear();
  resetRecoveryCopyNoticeForTests();
});

describe('notifyRecoveryCopySkipped', () => {
  it('called twice for p1 → toast.warn once; then p2 → a second call', () => {
    notifyRecoveryCopySkipped('p1');
    notifyRecoveryCopySkipped('p1');

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(RECOVERY_COPY_SKIPPED_MESSAGE, { autoClose: 8000 });

    notifyRecoveryCopySkipped('p2');

    expect(warn).toHaveBeenCalledTimes(2);
  });
});
