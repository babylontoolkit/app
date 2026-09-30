/**
 * The path wall and shape checks (D20, D21). These cases are copied VERBATIM as data into the Desktop
 * Agent's `tests/bridge-policy.test.js` (D3) — change both together.
 */
import { describe, expect, it } from 'vitest';
import { capText, type BridgeOperation } from './protocol';
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

  it.each(['yes', 'project-path', 'non-interactive', 'result-only', 'detach', 'project'])(
    'reserved param key %s → sentence',
    (key) => {
      expect(typeof validateOperation({ kind: 'unity.command', name: 'set_transform', params: { [key]: true } })).toBe(
        'string',
      );
    },
  );

  it.each(['--yes', '1abc', 'a b', 'x'.repeat(65)])('invalid param key %s → sentence', (key) => {
    expect(typeof validateOperation({ kind: 'unity.command', name: 'set_transform', params: { [key]: 1 } })).toBe(
      'string',
    );
  });

  it("{format:'yaml', timeout:5} (real command params) → null", () => {
    expect(
      validateOperation({
        kind: 'unity.command',
        name: 'get_serialized_fields',
        params: { format: 'yaml', timeout: 5 },
      }),
    ).toBeNull();
  });

  it('unity.capture 2048 → sentence', () => {
    expect(typeof validateOperation({ kind: 'unity.capture', view: 'game', width: 2048, height: 512 })).toBe('string');
  });

  it("unity.script entry 'Build' (no dot) → sentence", () => {
    expect(typeof validateOperation({ kind: 'unity.script', source: 'class A {}', entry: 'Build' })).toBe('string');
  });

  it('unity.project open with no name → sentence', () => {
    expect(typeof validateOperation({ kind: 'unity.project', action: 'open' } as BridgeOperation)).toBe('string');
  });

  it('unity.project create with no name → sentence', () => {
    expect(typeof validateOperation({ kind: 'unity.project', action: 'create' } as BridgeOperation)).toBe('string');
  });

  it("unity.project open '../x' → sentence", () => {
    expect(typeof validateOperation({ kind: 'unity.project', action: 'open', name: '../x' } as BridgeOperation)).toBe(
      'string',
    );
  });

  it("unity.project create '../x' → sentence", () => {
    expect(typeof validateOperation({ kind: 'unity.project', action: 'create', name: '../x' } as BridgeOperation)).toBe(
      'string',
    );
  });

  it("unity.project create 'a..b' → sentence", () => {
    expect(typeof validateOperation({ kind: 'unity.project', action: 'create', name: 'a..b' } as BridgeOperation)).toBe(
      'string',
    );
  });

  it("unity.project create 'x.' (trailing dot) → sentence", () => {
    expect(typeof validateOperation({ kind: 'unity.project', action: 'create', name: 'x.' } as BridgeOperation)).toBe(
      'string',
    );
  });

  it("unity.project create 'Real ' (trailing space) → sentence", () => {
    expect(
      typeof validateOperation({ kind: 'unity.project', action: 'create', name: 'Real ' } as BridgeOperation),
    ).toBe('string');
  });

  it("unity.project open 'My Game' → null", () => {
    expect(validateOperation({ kind: 'unity.project', action: 'open', name: 'My Game' } as BridgeOperation)).toBeNull();
  });

  it("unity.project create 'My Game' → null", () => {
    expect(
      validateOperation({ kind: 'unity.project', action: 'create', name: 'My Game' } as BridgeOperation),
    ).toBeNull();
  });

  it("unity.project create 'Level_01-v2.0a' → null", () => {
    expect(
      validateOperation({ kind: 'unity.project', action: 'create', name: 'Level_01-v2.0a' } as BridgeOperation),
    ).toBeNull();
  });

  it('unity.project list → null', () => {
    expect(validateOperation({ kind: 'unity.project', action: 'list' } as BridgeOperation)).toBeNull();
  });

  it("unity.project list with name '../ignored' → null", () => {
    expect(
      validateOperation({ kind: 'unity.project', action: 'list', name: '../ignored' } as BridgeOperation),
    ).toBeNull();
  });

  it("unity.project action 'delete' → sentence", () => {
    expect(typeof validateOperation({ kind: 'unity.project', action: 'delete' } as unknown as BridgeOperation)).toBe(
      'string',
    );
  });

  it('unity.project refusal sentences are exact (the helper carries the same three)', () => {
    expect(validateOperation({ kind: 'unity.project', action: 'delete' } as unknown as BridgeOperation)).toBe(
      'unity_project action must be list, open or create.',
    );
    expect(validateOperation({ kind: 'unity.project', action: 'create' })).toBe(
      'unity_project needs a project name for create.',
    );
    expect(validateOperation({ kind: 'unity.project', action: 'open', name: 'a/b' })).toBe(
      'The Unity project name "a/b" is not valid — use letters, numbers, spaces, dots, dashes or underscores.',
    );
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
