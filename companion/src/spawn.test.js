/**
 * The parts of the launcher that are testable without uvx or a Unity Editor.
 *
 * `spawnUnityMcpServer` is deliberately NOT exercised here — actually launching the Unity MCP server
 * needs uv on PATH and an open Editor, so a test that tried would be a machine-dependent failure
 * pretending to be a code failure. What IS tested is everything the CLI's error paths depend on:
 * whether a port came up, and whether a launcher exists at all.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { waitForPort, commandExists, DEFAULT_SERVER_COMMAND } from './spawn.js';

/** Bind an ephemeral port and hand back both the port and a closer. */
function listenEphemeral() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();

    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

/** A port nothing is listening on: bind it to learn a free number, then release it. */
async function closedPort() {
  const { port, close } = await listenEphemeral();
  await close();

  return port;
}

test('waitForPort resolves true against a real listening server', async () => {
  const server = await listenEphemeral();

  try {
    assert.equal(await waitForPort(server.port, { timeoutMs: 2000, intervalMs: 50 }), true);
  } finally {
    await server.close();
  }
});

test('waitForPort resolves false — and gives up promptly — against a closed port', async () => {
  const port = await closedPort();
  const startedAt = Date.now();

  const result = await waitForPort(port, { timeoutMs: 600, intervalMs: 50 });
  const elapsed = Date.now() - startedAt;

  assert.equal(result, false);
  assert.ok(
    elapsed < 5000,
    `waitForPort honoured neither the timeout nor the poll interval (took ${elapsed}ms for a 600ms budget)`,
  );
});

test('waitForPort returns true as soon as the port opens, without waiting out the timeout', async () => {
  const port = await closedPort();
  let server;

  const opening = new Promise((resolve) => {
    setTimeout(async () => {
      const listener = net.createServer();

      listener.listen(port, '127.0.0.1', () => {
        server = listener;
        resolve();
      });
    }, 150);
  });

  try {
    const result = await waitForPort(port, { timeoutMs: 5000, intervalMs: 50 });

    await opening;
    assert.equal(result, true);
  } finally {
    await opening;

    if (server) {
      await new Promise((done) => server.close(() => done()));
    }
  }
});

test('commandExists finds a binary that is certainly on PATH', async () => {
  assert.equal(await commandExists('node'), true);
});

test('commandExists reports false for a binary that does not exist', async () => {
  assert.equal(await commandExists('definitely-not-a-real-binary-xyz'), false);
});

test('DEFAULT_SERVER_COMMAND is a non-empty command whose launcher is uvx', () => {
  assert.equal(typeof DEFAULT_SERVER_COMMAND, 'string');
  assert.ok(DEFAULT_SERVER_COMMAND.length > 0);

  const [launcher] = DEFAULT_SERVER_COMMAND.split(/\s+/).filter(Boolean);

  assert.equal(
    launcher,
    'uvx',
    'the CLI probes the FIRST token with commandExists — if that stops being the launcher, the ' +
      '"install uv" error message starts pointing at the wrong thing',
  );
});
