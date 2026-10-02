/**
 * Write the server's info/warn/error lines to a file as well as the terminal.
 *
 * Failed builds were undiagnosable: the reason a generation broke (`Generation … broke after …`, the
 * provider's own error text, every retry and resume) was logged only to the terminal running the dev
 * server, and gone once it scrolled. The generation record keeps the shape of a failure (steps, finish
 * reason) but not its message.
 *
 * On by default outside production at `.data/logs/server.log` (gitignored with the rest of `.data/`).
 * In production only when `SERVER_LOG_FILE` names a path — a container's stdout is already collected
 * there, and an unbounded file on a server disk is its own problem.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { setLogSink } from '~/utils/logger';

const ANSI = /\u001b\[[0-9;]*m/g;

export function resolveServerLogFile(env: { SERVER_LOG_FILE?: string; NODE_ENV?: string }, cwd: string) {
  if (env.SERVER_LOG_FILE) {
    return env.SERVER_LOG_FILE;
  }

  return env.NODE_ENV === 'production' ? undefined : path.join(cwd, '.data', 'logs', 'server.log');
}

export function formatServerLogLine(level: string, scope: string | undefined, text: string, now: Date): string {
  return `${now.toISOString()} ${level.toUpperCase()} ${scope ?? '-'} ${text.replace(ANSI, '')}\n`;
}

let installed = false;

export function installServerLogFile(): void {
  if (installed || typeof process === 'undefined') {
    return;
  }

  installed = true;

  const file = resolveServerLogFile(process.env, process.cwd());

  if (!file) {
    return;
  }

  try {
    mkdirSync(path.dirname(file), { recursive: true });
  } catch {
    return;
  }

  setLogSink((level, scope, text) => appendFileSync(file, formatServerLogLine(level, scope, text, new Date())));
}
