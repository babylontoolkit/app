/**
 * The path wall and shape checks (D20, D21). These cases are copied VERBATIM as data into the Desktop
 * Agent's `tests/bridge-policy.test.js` (D3) — change both together.
 */
import { describe, expect, it } from 'vitest';
import { capText } from './protocol';
import { isUnsafePath, validateOperation } from './validate';

describe('isUnsafePath', () => {
  it.each(['/etc', '~/x', 'C:\\x', 'a/../b'])('%s → true', (value) => {
    expect(isUnsafePath(value)).toBe(true);
  });

  it('Assets/x.png → false', () => {
    expect(isUnsafePath('Assets/x.png')).toBe(false);
  });

  it("'t:Texture' (a search filter, not a drive) → false", () => {
    expect(isUnsafePath('t:Texture')).toBe(false);
  });

  it.each(['C:', 'C:/x', 'C:\\x'])('drive %s → true', (value) => {
    expect(isUnsafePath(value)).toBe(true);
  });
});

describe('validateOperation', () => {
  it("unity.command screenshot {output:'/tmp/a.png'} → a sentence", () => {
    const result = validateOperation({ kind: 'unity.command', name: 'screenshot', params: { output: '/tmp/a.png' } });
    expect(typeof result).toBe('string');
    expect(result!.length).toBeGreaterThan(10);
  });

  it("{output:'.bridge/out/a.png'} → null", () => {
    expect(
      validateOperation({ kind: 'unity.command', name: 'screenshot', params: { output: '.bridge/out/a.png' } }),
    ).toBeNull();
  });

  it("{target:'/Directional Light'} (not a path param) → null", () => {
    expect(
      validateOperation({ kind: 'unity.command', name: 'set_transform', params: { target: '/Directional Light' } }),
    ).toBeNull();
  });

  it('unity.capture 2048 → sentence', () => {
    expect(typeof validateOperation({ kind: 'unity.capture', view: 'game', width: 2048, height: 512 })).toBe('string');
  });

  it("unity.script entry 'Build' (no dot) → sentence", () => {
    expect(typeof validateOperation({ kind: 'unity.script', source: 'class A {}', entry: 'Build' })).toBe('string');
  });
});

describe('capText', () => {
  it('25_000 chars → starts with the truncation notice and ends with the last char', () => {
    const text = 'a'.repeat(24_999) + 'Z';
    const capped = capText(text);
    expect(capped.startsWith('…(earlier output truncated)')).toBe(true);
    expect(capped.endsWith('Z')).toBe(true);
  });
});
