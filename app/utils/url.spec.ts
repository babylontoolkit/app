import { describe, expect, it } from 'vitest';
import { isAllowedUrl, isPrivateIpAddress, isValidUrl } from './url';

describe('isValidUrl', () => {
  it('accepts http/https only', () => {
    expect(isValidUrl('http://example.com')).toBe(true);
    expect(isValidUrl('https://example.com')).toBe(true);
    expect(isValidUrl('ftp://example.com')).toBe(false);
    expect(isValidUrl('file:///etc/passwd')).toBe(false);
    expect(isValidUrl('not a url')).toBe(false);
  });
});

describe('isAllowedUrl — public targets pass', () => {
  for (const url of [
    'https://example.com',
    'https://forums.unrealengine.com/some/thread',
    'http://93.184.216.34/', // a public IPv4 literal
    'https://[2606:2800:220:1:248:1893:25c8:1946]/', // a public IPv6 literal
  ]) {
    it(`allows ${url}`, () => expect(isAllowedUrl(url)).toBe(true));
  }
});

describe('isAllowedUrl — SSRF targets are blocked', () => {
  for (const url of [
    // named loopback
    'http://localhost/',
    'http://localhost:8080/admin',

    // IPv4 private / loopback / metadata
    'http://127.0.0.1/',
    'http://10.0.0.5/',
    'http://172.16.0.1/',
    'http://192.168.1.1/',
    'http://169.254.169.254/latest/meta-data/', // cloud metadata
    'http://0.0.0.0/',
    'http://100.64.0.1/', // CGNAT
    // numeric IPv4 encodings the URL parser normalizes to 127.0.0.1
    'http://2130706433/', // decimal
    'http://0x7f000001/', // hex
    'http://0177.0.0.1/', // octal
    'http://127.1/', // short form
    // IPv6 loopback / ULA / link-local / mapped
    'http://[::1]/',
    'http://[fc00::1]/',
    'http://[fd12:3456::1]/',
    'http://[fe80::1]/',
    'http://[::ffff:127.0.0.1]/', // IPv4-mapped loopback
    'http://[::ffff:10.0.0.1]/', // IPv4-mapped private
  ]) {
    it(`blocks ${url}`, () => expect(isAllowedUrl(url)).toBe(false));
  }

  it('rejects non-http(s) schemes outright', () => {
    expect(isAllowedUrl('file:///etc/passwd')).toBe(false);
    expect(isAllowedUrl('gopher://127.0.0.1/')).toBe(false);
  });
});

describe('isPrivateIpAddress — vets DNS-resolved addresses', () => {
  it('flags private v4', () => {
    expect(isPrivateIpAddress('127.0.0.1')).toBe(true);
    expect(isPrivateIpAddress('10.1.2.3')).toBe(true);
    expect(isPrivateIpAddress('169.254.169.254')).toBe(true);
    expect(isPrivateIpAddress('192.168.0.10')).toBe(true);
  });

  it('flags private v6 (brackets optional)', () => {
    expect(isPrivateIpAddress('::1')).toBe(true);
    expect(isPrivateIpAddress('[::1]')).toBe(true);
    expect(isPrivateIpAddress('fe80::1')).toBe(true);
    expect(isPrivateIpAddress('::ffff:127.0.0.1')).toBe(true);
  });

  it('passes public addresses', () => {
    expect(isPrivateIpAddress('8.8.8.8')).toBe(false);
    expect(isPrivateIpAddress('2606:2800:220:1:248:1893:25c8:1946')).toBe(false);
  });

  it('treats an unparseable address as unsafe (fail-closed)', () => {
    expect(isPrivateIpAddress('not-an-ip')).toBe(true);
  });
});
