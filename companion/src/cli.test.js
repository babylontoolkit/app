/**
 * THE ACCEPTANCE PROOF for the `--attach` path.
 *
 * Everything else in this package tests a module. This one tests the PRODUCT: it spawns the real bin
 * as a child process, exactly the way `pnpm companion --attach <port>` does, points it at a real stub
 * upstream over a real socket, and drives it with real `fetch` — the programmatic equivalent of the
 * `curl` checks in the acceptance criteria. Nothing is mocked; the only stand-in is the Unity MCP
 * server itself, which is a `node:http` server that records what reached it.
 *
 * The load-bearing assertion is NEGATIVE: an unauthorised POST must not merely come back 401, it must
 * never have TOUCHED the editor. A proxy that forwarded first and refused afterwards would satisfy a
 * status-code-only test while handing an unpaired page control of the user's Editor, so the stub's
 * request count is what actually proves the wall.
 *
 * The child is spawned with piped stdio and killed in `finally`, because a leaked child keeps the test
 * runner's process alive and turns a passing suite into a hang.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Resolved from this module's own location so the test runs from any cwd.
const CLI_PATH = fileURLToPath(new URL('./cli.js', import.meta.url));
const REPO_ROOT = path.resolve(path.dirname(CLI_PATH), '..', '..');

const TOKEN = 'test-token-123';
const UPSTREAM_BODY = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: [] } });
const SESSION_ID = 'session-e2e-42';
const BANNER_TIMEOUT_MS = 15_000;

/** Everything the suite opened, torn down in `after` so the process can exit cleanly. */
const cleanups = [];

after(async () => {
  await Promise.all(cleanups.map((fn) => fn()));
});

/** A stub Unity MCP server that records every request that actually reached it. */
async function startUpstream() {
  const received = [];
  const server = http.createServer((req, res) => {
    const chunks = [];

    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      received.push({ method: req.method, url: req.url, body: Buffer.concat(chunks).toString() });
      res.writeHead(200, { 'content-type': 'application/json', 'Mcp-Session-Id': SESSION_ID });
      res.end(UPSTREAM_BODY);
    });
  });

  const port = await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });

  const close = () => new Promise((done) => server.close(() => done()));

  cleanups.push(close);

  return { port, received, close };
}

/**
 * Let anything already in flight reach the stub before a "nothing arrived" assertion is made.
 * Without this, a negative assertion is a race the wrong way round: it passes by being early.
 */
function settle(ms = 150) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A port nothing holds: bind to learn a free number, then release it for the CLI to take. */
async function freePort() {
  const server = net.createServer();

  const port = await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });

  await new Promise((done) => server.close(() => done()));

  return port;
}

/**
 * Spawn the REAL CLI and wait for its startup banner.
 *
 * Resolves once the banner is seen; rejects (rather than hanging) if it never arrives, so a CLI that
 * silently fails to listen reports itself instead of stalling the suite.
 */
async function startCli(args) {
  const child = spawn(process.execPath, [CLI_PATH, ...args], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => (stdout += chunk));
  child.stderr.on('data', (chunk) => (stderr += chunk));

  /*
   * Idempotent: `exit` fires ONCE, so a second call that waited on it again would block until the
   * SIGKILL fallback and silently add 5s to the suite (which is exactly what it did before this
   * guard — the child had already exited cleanly).
   */
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) {
      return;
    }

    child.kill('SIGTERM');

    await new Promise((resolve) => {
      const done = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 5000);

      child.once('exit', () => {
        clearTimeout(done);
        resolve();
      });
    });
  };

  cleanups.push(stop);

  await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => {
      reject(
        new Error(
          `The companion never printed its startup banner within ${BANNER_TIMEOUT_MS}ms.\n` +
            `--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
        ),
      );
    }, BANNER_TIMEOUT_MS);

    const check = () => {
      if (/Unity companion is running/.test(stdout)) {
        clearTimeout(deadline);
        resolve();
      }
    };

    child.stdout.on('data', check);
    child.once('exit', (code) => {
      clearTimeout(deadline);
      reject(new Error(`The companion exited early with code ${code}.\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    });

    check();
  });

  return { child, stop, getStdout: () => stdout, getStderr: () => stderr };
}

test('the real CLI --attach path: proxies a stubbed upstream, answers PNA, and walls off untokened POSTs', async (t) => {
  const upstream = await startUpstream();
  const port = await freePort();

  const cli = await startCli(['--attach', String(upstream.port), '--port', String(port), '--token', TOKEN]);
  const url = `http://127.0.0.1:${port}/mcp`;

  try {
    await t.test('the banner tells the user the port and the token', () => {
      const stdout = cli.getStdout();

      assert.match(stdout, new RegExp(`Port:\\s+${port}`), 'the banner must print the port to paste into the app');
      assert.match(stdout, new RegExp(`Token:\\s+${TOKEN}`), 'the banner must print the pairing token');
      assert.match(stdout, /127\.0\.0\.1/, 'the banner should state that it is loopback-only');
      assert.doesNotMatch(stdout, /Starting the Unity MCP server/, '--attach must not spawn a server');
    });

    await t.test('OPTIONS preflight → 204 with the private-network + expose-headers answer', async () => {
      const res = await fetch(url, {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://app.example.com',
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Private-Network': 'true',
        },
      });

      assert.equal(res.status, 204);
      assert.equal(
        res.headers.get('access-control-allow-private-network'),
        'true',
        'without this the browser fails the request before the POST, and it looks like the companion is not running',
      );
      assert.equal(
        res.headers.get('access-control-expose-headers'),
        'mcp-session-id',
        'an unexposed session header silently restarts the MCP session on every request',
      );
      assert.equal(res.headers.get('access-control-allow-origin'), '*');
      assert.match(res.headers.get('access-control-allow-methods') ?? '', /POST/);

      await settle();
      assert.equal(upstream.received.length, 0, 'the preflight must be answered locally, never forwarded');
    });

    await t.test('POST with no Authorization → 401, and the editor never saw it', async () => {
      const res = await fetch(url, {
        method: 'POST',
        headers: { Origin: 'https://app.example.com', 'content-type': 'application/json' },
        body: '{"jsonrpc":"2.0","method":"tools/list","id":1}',
      });

      assert.equal(res.status, 401);
      assert.match((await res.json()).error, /token/i);

      /*
       * The refusal is written SYNCHRONOUSLY, so it comes back before a forwarded request would have
       * finished — asserting the count the instant `fetch` resolves passes even on a proxy that
       * forwards first and refuses afterwards (verified: that mutation slipped straight through).
       * Settling first is what makes this assertion mean what it says.
       */
      await settle();
      assert.equal(upstream.received.length, 0, 'an unauthorised request REACHED the editor');
    });

    await t.test('POST with the pairing token → 200, body verbatim, Mcp-Session-Id survives', async () => {
      const body = '{"jsonrpc":"2.0","method":"tools/list","id":7}';

      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Origin: 'https://app.example.com',
          Authorization: `Bearer ${TOKEN}`,
          'content-type': 'application/json',
        },
        body,
      });

      assert.equal(res.status, 200);
      assert.equal(await res.text(), UPSTREAM_BODY, 'the proxy must not rewrite the MCP payload');
      assert.equal(res.headers.get('mcp-session-id'), SESSION_ID);

      assert.equal(upstream.received.length, 1);
      assert.equal(upstream.received[0].method, 'POST');
      assert.equal(upstream.received[0].url, '/mcp');
      assert.equal(upstream.received[0].body, body, 'the body must reach the editor byte-identical');
    });

    await t.test('SIGTERM shuts the companion down and frees the port', async () => {
      await cli.stop();

      assert.ok(
        cli.child.exitCode !== null || cli.child.signalCode !== null,
        'the CLI ignored SIGTERM — Ctrl+C would leave a process holding the port',
      );
      assert.match(cli.getStdout(), /Stopping the Unity companion/, 'shutdown should say so rather than dying mute');
      await assert.rejects(
        fetch(url, { method: 'OPTIONS', headers: { Origin: 'https://app.example.com' } }),
        'the port is still accepting connections after shutdown',
      );
    });
  } finally {
    await cli.stop();
    await upstream.close();
  }
});

/*
 * Attaching to nothing must fail at STARTUP, not at request time.
 *
 * Without the probe the companion prints its "✅ running" banner and then 502s every request — so the
 * user reads a success message, pastes the port into the app, and blames the app for the failure.
 * The absent banner is as load-bearing as the exit code: a success message that precedes a broken
 * state is worse than no message.
 */
test('--attach to a port nothing is listening on exits 1 with no success banner', async () => {
  const dead = await freePort();
  let port = await freePort();

  while (port === dead) {
    port = await freePort();
  }

  const child = spawn(process.execPath, [CLI_PATH, '--attach', String(dead), '--port', String(port)], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => (stdout += chunk));
  child.stderr.on('data', (chunk) => (stderr += chunk));

  /*
   * BOUNDED: the failure mode under test is "the companion keeps running when it should have bailed",
   * and an unbounded `once('exit')` would HANG on exactly that regression instead of reporting it. A
   * test that hangs on the bug it exists to catch reads as a broken suite, not a broken product.
   */
  const code = await new Promise((resolve) => {
    const giveUp = setTimeout(() => {
      child.kill('SIGKILL');
      resolve('TIMEOUT');
    }, 10_000);

    child.once('exit', (exitCode) => {
      clearTimeout(giveUp);
      resolve(exitCode);
    });
  });

  assert.notEqual(code, 'TIMEOUT', 'the companion kept running with nothing on the --attach port');
  assert.equal(code, 1, `expected exit 1, got ${code}.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  assert.match(stderr, /--attach/, 'the error must name the flag that is wrong');
  assert.match(stderr, new RegExp(String(dead)), 'the error should name the port it probed');
  assert.doesNotMatch(stdout, /✅/, 'a companion that cannot reach its upstream must not report success');
  assert.doesNotMatch(stdout, /Unity companion is running/);
});

test('--help prints usage and exits 0 without binding a port', async () => {
  const child = spawn(process.execPath, [CLI_PATH, '--help'], { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });

  let stdout = '';

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => (stdout += chunk));

  const code = await new Promise((resolve) => child.once('exit', resolve));

  assert.equal(code, 0);
  assert.match(stdout, /Usage:/);
  assert.match(stdout, /--attach/);
});

test('a bad flag exits non-zero with the error and the usage text', async () => {
  const child = spawn(process.execPath, [CLI_PATH, '--prot', '9000'], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderr = '';

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => (stderr += chunk));

  const code = await new Promise((resolve) => child.once('exit', resolve));

  assert.equal(code, 1, 'a misuse that exits 0 tells a script the companion started when it did not');
  assert.match(stderr, /Unknown argument/i);
});
