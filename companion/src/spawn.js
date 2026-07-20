/**
 * Launching (or attaching to) the Unity MCP server.
 *
 * The server is CoplayDev's `mcp-for-unity` (MIT), run through `uvx` so the user installs nothing
 * globally. We spawn it in HTTP mode on a PRIVATE loopback port and put the companion proxy in front
 * of it — the browser never talks to it directly, which is what lets us add the CORS/PNA answer and
 * the pairing token without patching upstream.
 *
 * ⚠️ Upstream's published docs disagree about how HTTP mode is selected: the install page documents
 * `--transport stdio` (implying `--transport http`), while the CLI reference documents neither that
 * flag nor the `UNITY_MCP_*` env vars that its release notes and issues reference. So we set BOTH the
 * env vars and the flag, and expose `--server-command` to override the whole invocation. Guessing one
 * form and hard-coding it would strand every user whose version expects the other — and the failure
 * would look like "the companion is broken", not "the flag moved".
 */
import { spawn } from 'node:child_process';

export const DEFAULT_SERVER_COMMAND = 'uvx --from mcpforunityserver mcp-for-unity';

/**
 * Spawn the Unity MCP server in HTTP mode.
 *
 * @param {object} options
 * @param {number} options.port Loopback port the server should listen on.
 * @param {string} options.token Instance token, also enforced by our proxy.
 * @param {string} [options.serverCommand] Full override for the launch command.
 * @returns {import('node:child_process').ChildProcess}
 */
export function spawnUnityMcpServer({ port, token, serverCommand = DEFAULT_SERVER_COMMAND }) {
  const [command, ...args] = serverCommand.split(/\s+/).filter(Boolean);

  const child = spawn(command, [...args, '--transport', 'http', '--port', String(port)], {
    env: {
      ...process.env,
      UNITY_MCP_TRANSPORT: 'http',
      UNITY_MCP_HTTP_HOST: '127.0.0.1',
      UNITY_MCP_HTTP_PORT: String(port),
      UNITY_MCP_INSTANCE_TOKEN: token,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  return child;
}

/**
 * Wait until something is listening on `port`, or give up.
 *
 * Polls a plain TCP connect rather than an MCP handshake: at this stage we only need to know the
 * process is up, and an MCP `initialize` here would consume a session the browser is about to open.
 *
 * @param {number} port
 * @param {object} [options]
 * @param {number} [options.timeoutMs]
 * @param {number} [options.intervalMs]
 * @returns {Promise<boolean>}
 */
export async function waitForPort(port, { timeoutMs = 30_000, intervalMs = 250 } = {}) {
  const { connect } = await import('node:net');
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const open = await new Promise((resolve) => {
      const socket = connect({ host: '127.0.0.1', port }, () => {
        socket.end();
        resolve(true);
      });

      socket.on('error', () => resolve(false));
      socket.setTimeout(1000, () => {
        socket.destroy();
        resolve(false);
      });
    });

    if (open) {
      return true;
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  return false;
}

/** Whether a launcher binary exists on PATH — so a missing `uvx` is a clear message, not a stack trace. */
export async function commandExists(command) {
  const { spawnSync } = await import('node:child_process');
  const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', [command], { stdio: 'ignore' });

  return probe.status === 0;
}
