/**
 * The flag contract.
 *
 * `parseArgs` is pure precisely so this can be exhaustive without spawning a server, and the
 * validation cases matter more than the happy ones: every error here is a footgun that would
 * otherwise surface as a confusing runtime failure (a proxy that loops onto itself, a port the OS
 * refuses, a typo'd flag silently ignored).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, DEFAULT_PORT, HELP_TEXT } from './args.js';
import { DEFAULT_SERVER_COMMAND } from './spawn.js';

test('no arguments yields the documented defaults', () => {
  const parsed = parseArgs([]);

  assert.equal(parsed.port, DEFAULT_PORT);
  assert.equal(DEFAULT_PORT, 8080, 'the default port is part of the published UX; changing it is a breaking change');
  assert.equal(parsed.attach, null, 'null means "spawn a server", not "attach to port 0"');
  assert.equal(parsed.origin, undefined);
  assert.equal(parsed.token, undefined);
  assert.equal(parsed.serverCommand, DEFAULT_SERVER_COMMAND);
  assert.equal(parsed.help, false);
  assert.deepEqual(parsed.errors, []);
});

test('--port overrides the listen port', () => {
  const parsed = parseArgs(['--port', '9000']);

  assert.equal(parsed.port, 9000);
  assert.deepEqual(parsed.errors, []);
});

test('--attach records an already-running server port and leaves --port alone', () => {
  const parsed = parseArgs(['--attach', '8081']);

  assert.equal(parsed.attach, 8081);
  assert.equal(parsed.port, DEFAULT_PORT);
  assert.deepEqual(parsed.errors, []);
});

test('--origin, --token and --server-command capture their values verbatim', () => {
  const parsed = parseArgs([
    '--origin',
    'https://app.example.com',
    '--token',
    'my-fixed-token',
    '--server-command',
    'uv run mcp-for-unity',
  ]);

  assert.equal(parsed.origin, 'https://app.example.com');
  assert.equal(parsed.token, 'my-fixed-token');
  assert.equal(parsed.serverCommand, 'uv run mcp-for-unity');
  assert.deepEqual(parsed.errors, []);
});

/*
 * A value-taking flag with no value must ERROR, never fall back silently. `--origin` and `--token`
 * are security-shaped: a silent fallback answers any origin, or mints a token the user did not
 * choose, while the user believes they restricted something. The flag would fail OPEN and say
 * nothing — the worst available outcome, since the command looks like it worked.
 */
test('a trailing --origin (no value) is an error, and origin stays undefined', () => {
  const parsed = parseArgs(['--origin']);

  assert.ok(
    parsed.errors.some((e) => /--origin/.test(e)),
    `expected an --origin error, got ${JSON.stringify(parsed.errors)}`,
  );
  assert.equal(parsed.origin, undefined, 'a rejected --origin must not become a truthy allowed origin');
});

test('a trailing --token (no value) is an error, and token stays undefined', () => {
  const parsed = parseArgs(['--token']);

  assert.ok(parsed.errors.some((e) => /--token/.test(e)));
  assert.equal(parsed.token, undefined);
});

test('a trailing --server-command is an error AND keeps the default command', () => {
  const parsed = parseArgs(['--server-command']);

  assert.ok(parsed.errors.some((e) => /--server-command/.test(e)));
  assert.equal(
    parsed.serverCommand,
    DEFAULT_SERVER_COMMAND,
    'a rejected value must not blank the command the CLI is about to probe and spawn',
  );
});

test('a following FLAG is not accepted as a value', () => {
  const origin = parseArgs(['--origin', '--token', 'abc']);

  assert.ok(origin.errors.some((e) => /--origin/.test(e)));
  assert.equal(origin.origin, undefined, '"--token" must never become the allowed origin');
  assert.notEqual(origin.origin, '--token');

  const token = parseArgs(['--token', '--origin', 'https://app.example.com']);

  assert.ok(token.errors.some((e) => /--token/.test(e)));
  assert.equal(token.token, undefined, '"--origin" must never become the pairing token');

  const command = parseArgs(['--server-command', '--port', '9000']);

  assert.ok(command.errors.some((e) => /--server-command/.test(e)));
  assert.equal(command.serverCommand, DEFAULT_SERVER_COMMAND);
});

test('a valid value that merely CONTAINS dashes is still accepted', () => {
  const parsed = parseArgs(['--token', 'a-b-c-123', '--origin', 'https://my-app.example.com']);

  assert.deepEqual(parsed.errors, [], 'the flag guard must reject leading "--", not any dash');
  assert.equal(parsed.token, 'a-b-c-123');
  assert.equal(parsed.origin, 'https://my-app.example.com');
});

test('--help and -h both set the help flag', () => {
  assert.equal(parseArgs(['--help']).help, true);
  assert.equal(parseArgs(['-h']).help, true);
});

test('HELP_TEXT documents every flag the parser accepts', () => {
  for (const flag of ['--port', '--attach', '--origin', '--token', '--server-command', '--help']) {
    assert.match(HELP_TEXT, new RegExp(flag.replace(/-/g, '\\-')), `${flag} is accepted but undocumented`);
  }
});

test('out-of-range and non-numeric ports are rejected', () => {
  for (const bad of ['0', '99999', 'abc', '-1', '65536']) {
    const parsed = parseArgs(['--port', bad]);

    assert.ok(parsed.errors.length > 0, `--port ${bad} was accepted`);
    assert.equal(parsed.port, DEFAULT_PORT, `--port ${bad} must not overwrite the default with junk`);
  }
});

test('a bad --attach is rejected and leaves attach null', () => {
  const parsed = parseArgs(['--attach', 'abc']);

  assert.ok(parsed.errors.length > 0);
  assert.equal(parsed.attach, null, 'a rejected --attach must not become a truthy upstream port');
});

test('an unknown argument is an error, never silently ignored', () => {
  const parsed = parseArgs(['--prot', '9000']);

  assert.ok(parsed.errors.some((e) => /unknown argument/i.test(e)));
});

test('--attach equal to --port is refused as a self-proxy loop', () => {
  const parsed = parseArgs(['--port', '8080', '--attach', '8080']);

  assert.equal(parsed.errors.length, 1);
  assert.match(parsed.errors[0], /proxy itself|self/i);
});

test('--attach equal to the DEFAULT port is caught too (no --port given)', () => {
  const parsed = parseArgs(['--attach', String(DEFAULT_PORT)]);

  assert.ok(parsed.errors.length > 0, 'the loop check must run against the effective port, not only an explicit one');
});

test('errors accumulate — the user sees every problem in one run', () => {
  const parsed = parseArgs(['--port', '0', '--nope', '--attach', 'abc']);

  assert.ok(parsed.errors.length >= 3, `expected 3+ errors, got ${JSON.stringify(parsed.errors)}`);
});
