/**
 * The project sentinel's two halves, and why they fail in OPPOSITE directions
 * (`spec/sandbox-codesandbox.md` §11 C1).
 *
 * `readSandboxIdentity` feeds the warm-boot gate (`liveSandboxIsTruth` in `useChatHistory`), which
 * decides whether the live sandbox disk outranks every client-held copy. So the two ways of being
 * wrong are asymmetric and both silent:
 *
 *   - answering `mismatch` where the truth is "no claim" closes the gate on a healthy warm VM and
 *     restores a stale client copy over live work (the MEASURED bug: a working copy serialized
 *     mid-watcher-lag reverted a generated `Home.css` two hours after it was built);
 *   - answering anything but `mismatch` for a sandbox that genuinely belongs to another project lets
 *     that project's files become this project's truth, and then be pushed to this project's repo.
 *
 * The write half is pure insurance, so its failure direction is the other one: it must never be able
 * to stop a project from opening.
 */
import { describe, expect, it, vi } from 'vitest';
import { SANDBOX_IDENTITY_DIR, SANDBOX_IDENTITY_PATH, identitySentinel } from './boot-decisions';
import { readSandboxIdentity, writeSandboxIdentity } from './identity';
import type { SandboxProvider } from './types';

/**
 * A provider whose `fs` is the only part these functions touch.
 *
 * Deliberately inert everywhere else: the claim under test is what the identity module does with a
 * filesystem's answers, so its collaborators do nothing on purpose rather than by omission.
 */
function providerWithFs(fs: Partial<SandboxProvider['fs']>): SandboxProvider {
  return { fs } as unknown as SandboxProvider;
}

describe('readSandboxIdentity', () => {
  it('reads the sentinel from the .codesandbox path, as text', async () => {
    const readFile = vi.fn(async () => identitySentinel('prj_a'));
    const verdict = await readSandboxIdentity(providerWithFs({ readFile } as never), 'prj_a');

    expect(verdict).toBe('match');
    expect(readFile).toHaveBeenCalledWith(SANDBOX_IDENTITY_PATH, 'utf8');
  });

  /*
   * 🔴 The one verdict that closes the gate. With per-project VMs this should never fire, which is
   * exactly why it is worth having: the failure it catches (a mis-pointed `sandbox_id`) is otherwise
   * completely silent.
   */
  it('reports a mismatch when the sandbox claims another project', async () => {
    const provider = providerWithFs({ readFile: async () => identitySentinel('prj_b') } as never);

    expect(await readSandboxIdentity(provider, 'prj_a')).toBe('mismatch');
  });

  /*
   * 🔴 NEVER `mismatch` on failure. A sandbox created before the sentinel existed, one whose
   * `.codesandbox/` was cleaned, and a provider whose `readFile` rejects for any reason at all are
   * the same case: no claim. Turning "I could not read it" into "it belongs to someone else" would
   * take every warm VM in existence down the restore path.
   */
  it.each([
    ['the file does not exist', new Error('ENOENT: no such file or directory')],
    ['the provider cannot read it', new Error('Pitcher message fs/readFile timed out')],
  ])('answers unknown when %s', async (_label, error) => {
    const provider = providerWithFs({
      readFile: async () => {
        throw error;
      },
    } as never);

    expect(await readSandboxIdentity(provider, 'prj_a')).toBe('unknown');
  });

  it('answers unknown for a corrupt sentinel rather than guessing', async () => {
    const provider = providerWithFs({ readFile: async () => '{"projectId": "prj_' } as never);

    expect(await readSandboxIdentity(provider, 'prj_a')).toBe('unknown');
  });
});

describe('writeSandboxIdentity', () => {
  it('creates the directory first, then stamps the sentinel for this project', async () => {
    const order: string[] = [];
    const mkdir = vi.fn(async () => {
      order.push('mkdir');
      return SANDBOX_IDENTITY_DIR;
    });
    const writeFile = vi.fn(async () => {
      order.push('writeFile');
    });

    await writeSandboxIdentity(providerWithFs({ mkdir, writeFile } as never), 'prj_a');

    /* `mkdir` after `writeFile` would fail on every sandbox that has no `.codesandbox/` yet — i.e. every new one. */
    expect(order).toEqual(['mkdir', 'writeFile']);
    expect(mkdir).toHaveBeenCalledWith(SANDBOX_IDENTITY_DIR, { recursive: true });
    expect(writeFile).toHaveBeenCalledWith(SANDBOX_IDENTITY_PATH, identitySentinel('prj_a'));
  });

  /*
   * 🔴 Best-effort by construction, in BOTH failure spots. The sentinel is defense in depth for a
   * gate that already has per-project VMs behind it; refusing to open a project because a marker file
   * could not be written would turn insurance into an outage — and it would do so on exactly the
   * degraded sandbox where the user most needs to get at their work.
   */
  it.each([
    ['mkdir', { mkdir: async () => Promise.reject(new Error('EACCES')), writeFile: vi.fn(async () => undefined) }],
    ['writeFile', { mkdir: vi.fn(async () => '.'), writeFile: async () => Promise.reject(new Error('ENOSPC')) }],
  ])('never rejects when %s fails', async (_label, fs) => {
    await expect(writeSandboxIdentity(providerWithFs(fs as never), 'prj_a')).resolves.toBeUndefined();
  });
});
