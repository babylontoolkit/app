#!/usr/bin/env node
/**
 * `npx @babylonjs-toolkit/bridge` — one command that makes the local Unity Editor reachable from the
 * browser-based app builder.
 *
 * What it does, in order: mint a pairing token, get a Unity MCP server running (spawn one, or attach
 * to the user's), stand up the CORS/PNA + token proxy in front of it on 127.0.0.1, and print the port
 * and token for the user to paste into the Connect Unity dialog.
 *
 * The printed token is the whole security model, so the output says so plainly rather than
 * presenting it as a config value to be shared around.
 */
import { createProxyServer } from './proxy.js';
import { mintToken } from './token.js';
import { parseArgs, HELP_TEXT } from './args.js';
import { spawnUnityMcpServer, waitForPort, commandExists } from './spawn.js';

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    console.log(HELP_TEXT);
    return;
  }

  if (options.errors.length > 0) {
    for (const error of options.errors) {
      console.error(`✖ ${error}`);
    }

    console.error(`\n${HELP_TEXT}`);
    process.exitCode = 1;

    return;
  }

  const token = options.token ?? mintToken();
  let child;
  let upstreamPort = options.attach;

  if (upstreamPort !== null) {
    /*
     * Attaching to nothing must fail HERE. Without this probe the companion prints its "running"
     * banner and then 502s every request — the user reads a success message and blames the app.
     */
    const reachable = await waitForPort(upstreamPort, { timeoutMs: 2000 });

    if (!reachable) {
      console.error(
        `✖ Nothing is listening on 127.0.0.1:${upstreamPort}.\n` +
          `  --attach expects an already-running Unity MCP server on that port.\n` +
          `  Drop --attach to have the companion start one for you.`,
      );
      process.exitCode = 1;

      return;
    }
  }

  if (upstreamPort === null) {
    // The server sits on the port next door; only the proxy is ever exposed to the browser.
    upstreamPort = options.port + 1;

    const launcher = options.serverCommand.split(/\s+/)[0];

    if (!(await commandExists(launcher))) {
      console.error(
        `✖ Could not find "${launcher}" on your PATH.\n` +
          `  The Unity MCP server runs through uv. Install it from https://docs.astral.sh/uv/ ,\n` +
          `  or start the server yourself and re-run with --attach <port>.`,
      );
      process.exitCode = 1;

      return;
    }

    console.log(`⏳ Starting the Unity MCP server on 127.0.0.1:${upstreamPort} …`);
    child = spawnUnityMcpServer({ port: upstreamPort, token, serverCommand: options.serverCommand });

    child.stderr?.on('data', (chunk) => process.stderr.write(`[unity-mcp] ${chunk}`));
    child.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        console.error(`✖ The Unity MCP server exited with code ${code}.`);
        process.exitCode = 1;
      }
    });

    const ready = await waitForPort(upstreamPort);

    if (!ready) {
      console.error(
        `✖ The Unity MCP server did not start listening on ${upstreamPort}.\n` +
          `  Check that the MCP for Unity package is installed and the Editor is open,\n` +
          `  or pass --server-command to override how it is launched.`,
      );
      child.kill();
      process.exitCode = 1;

      return;
    }
  }

  const server = createProxyServer({ upstreamPort, token, allowedOrigin: options.origin });

  server.listen(options.port, '127.0.0.1', () => {
    console.log(
      [
        '',
        '✅ Unity companion is running.',
        '',
        `   Port:  ${options.port}`,
        `   Token: ${token}`,
        '',
        '   Paste those into the Connect Unity dialog in the app builder.',
        '   The token is what authorises the browser to drive your Editor — treat it',
        '   like a password, and do not share it. A new one is minted each run.',
        '',
        `   Listening on 127.0.0.1:${options.port} only${options.origin ? `, for origin ${options.origin}` : ''}.`,
        '   Press Ctrl+C to stop.',
        '',
      ].join('\n'),
    );
  });

  server.on('error', (error) => {
    console.error(`✖ Could not listen on port ${options.port}: ${error.message}`);
    child?.kill();
    process.exitCode = 1;
  });

  const shutdown = () => {
    console.log('\n👋 Stopping the Unity companion …');
    server.close();
    child?.kill();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error(`✖ ${error.message}`);
  process.exitCode = 1;
});
