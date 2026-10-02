/** The server log file (`server-log.ts`): where it goes, and that a line is readable plain text. */
import { describe, expect, it } from 'vitest';
import { formatServerLogLine, resolveServerLogFile } from './server-log';

describe('resolveServerLogFile', () => {
  it('writes under .data/logs in dev', () => {
    expect(resolveServerLogFile({ NODE_ENV: 'development' }, '/repo')).toBe('/repo/.data/logs/server.log');
  });

  it('writes nothing in production unless SERVER_LOG_FILE says where', () => {
    expect(resolveServerLogFile({ NODE_ENV: 'production' }, '/repo')).toBeUndefined();
    expect(resolveServerLogFile({ NODE_ENV: 'production', SERVER_LOG_FILE: '/var/log/app.log' }, '/repo')).toBe(
      '/var/log/app.log',
    );
  });
});

describe('formatServerLogLine', () => {
  it('stamps the time, level and scope, and strips terminal colours', () => {
    const line = formatServerLogLine('warn', 'agent-proxy', '\u001b[31mGeneration g1 broke\u001b[0m', new Date(0));

    expect(line).toBe('1970-01-01T00:00:00.000Z WARN agent-proxy Generation g1 broke\n');
  });
});
