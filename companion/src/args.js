/**
 * CLI argument parsing — pure, so the flag contract is testable without spawning anything.
 */
import { DEFAULT_SERVER_COMMAND } from './spawn.js';

export const DEFAULT_PORT = 8080;

/**
 * @param {string[]} argv Raw args (without node/script).
 * @returns {{port:number, attach:number|null, origin:string|undefined, token:string|undefined,
 *            serverCommand:string, help:boolean, errors:string[]}}
 */
export function parseArgs(argv) {
  const parsed = {
    port: DEFAULT_PORT,
    attach: null,
    origin: undefined,
    token: undefined,
    serverCommand: DEFAULT_SERVER_COMMAND,
    help: false,
    errors: [],
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];

    switch (arg) {
      case '--help':
      case '-h':
        parsed.help = true;
        break;

      case '--port': {
        const value = Number(next());

        if (!isValidPort(value)) {
          parsed.errors.push('--port must be a port number between 1 and 65535');
        } else {
          parsed.port = value;
        }

        break;
      }

      case '--attach': {
        const value = Number(next());

        if (!isValidPort(value)) {
          parsed.errors.push('--attach must be the port of an already-running Unity MCP server');
        } else {
          parsed.attach = value;
        }

        break;
      }

      /*
       * A value-taking flag with no value is an ERROR, never a silent default. `--origin` and
       * `--token` are security-shaped: swallowing a missing value would answer any origin, or mint a
       * token the user did not choose, while the user believes they restricted something. A flag that
       * fails open without saying so is worse than one that is absent.
       */
      case '--origin':
        parsed.origin = requireValue(next(), '--origin', parsed.errors);
        break;

      case '--token':
        parsed.token = requireValue(next(), '--token', parsed.errors);
        break;

      case '--server-command': {
        const value = requireValue(next(), '--server-command', parsed.errors);

        if (value !== undefined) {
          parsed.serverCommand = value;
        }

        break;
      }

      default:
        parsed.errors.push(`Unknown argument: ${arg}`);
        break;
    }
  }

  if (parsed.attach !== null && parsed.attach === parsed.port) {
    // Proxying a port onto itself would loop requests back into the companion forever.
    parsed.errors.push('--attach must differ from --port (the companion cannot proxy itself)');
  }

  return parsed;
}

function isValidPort(value) {
  return Number.isInteger(value) && value >= 1 && value <= 65535;
}

/** A flag's value, or undefined plus a recorded error when it is missing or is another flag. */
function requireValue(value, flag, errors) {
  if (value === undefined || value.startsWith('--')) {
    errors.push(`${flag} requires a value`);
    return undefined;
  }

  return value;
}

export const HELP_TEXT = `
babylonjs-toolkit bridge — connect your local Unity Editor to the browser-based app builder

Usage:
  npx @babylonjs-toolkit/bridge [options]

Options:
  --port <n>             Port the browser connects to (default ${DEFAULT_PORT}).
  --attach <n>           Use an already-running Unity MCP server on this port
                         instead of launching one.
  --origin <url>         Only accept requests from this app origin.
                         Omitted, any origin may connect (the pairing token is
                         still required).
  --token <secret>       Use a fixed pairing token instead of a fresh random one.
  --server-command <cmd> Override how the Unity MCP server is launched.
  -h, --help             Show this help.

Requires: the MCP for Unity package installed in your Unity project, and 'uvx'
(from Astral's uv) on your PATH unless you pass --attach.
`.trim();
