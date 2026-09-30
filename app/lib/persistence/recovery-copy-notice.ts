/**
 * The one "you are not protected" notice (spec A11, §4.5.4b: failed saves are never silent).
 *
 * The server recovery copy is skipped for SIZE in two places — the generation checkpoint and the
 * between-turn top-up — and the user must hear about it from either, but only once per project per
 * page load: the checkpoint fires on every generation, and a toast on each one is nagging that gets
 * dismissed unread. One module, one Set, so the two call sites cannot warn twice between them.
 */
import { toast } from 'react-toastify';

const warned = new Set<string>();

export const RECOVERY_COPY_SKIPPED_MESSAGE =
  'This project is not being backed up for crash recovery — sync it to a repository to keep it safe.';

/** Once per project per page load. Called wherever the server recovery copy is skipped for size. */
export function notifyRecoveryCopySkipped(projectId: string): void {
  if (warned.has(projectId)) {
    return;
  }

  warned.add(projectId);
  toast.warn(RECOVERY_COPY_SKIPPED_MESSAGE, { autoClose: 8000 });
}

export function resetRecoveryCopyNoticeForTests(): void {
  warned.clear();
}
