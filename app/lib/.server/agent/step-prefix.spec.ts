import { describe, expect, it } from 'vitest';
import { prefixChanges, stepPrefixHashes } from './step-prefix';

const body = (tools: unknown, system: unknown[]) => JSON.stringify({ model: 'm', tools, system, messages: [] });

describe('stepPrefixHashes', () => {
  it('hashes tools and each system block', () => {
    const hashes = stepPrefixHashes(body([{ name: 'read_file' }], [{ text: 'a' }, { text: 'b' }]));

    expect(hashes?.tools).toMatch(/^[0-9a-f]{10}$/);
    expect(hashes?.system).toHaveLength(2);
    expect(hashes?.system[0]).not.toBe(hashes?.system[1]);
  });

  it('reports no tools as none, and refuses a body that is not a Messages request', () => {
    expect(stepPrefixHashes(body(undefined, [{ text: 'a' }]))?.tools).toBe('none');
    expect(stepPrefixHashes(JSON.stringify({ input: 'x' }))).toBeUndefined();
    expect(stepPrefixHashes('not json')).toBeUndefined();
    expect(stepPrefixHashes(undefined)).toBeUndefined();
  });

  it('never carries the content itself', () => {
    const secret = 'THE WHOLE SYSTEM PROMPT';

    expect(JSON.stringify(stepPrefixHashes(body([], [{ text: secret }])))).not.toContain(secret);
  });
});

describe('prefixChanges', () => {
  const a = stepPrefixHashes(body([{ name: 't' }], [{ text: 'base' }, { text: 'files' }]));

  it('CONTROL: identical steps report nothing', () => {
    expect(prefixChanges(a, stepPrefixHashes(body([{ name: 't' }], [{ text: 'base' }, { text: 'files' }])))).toEqual(
      [],
    );
  });

  it('names the tools when the tool set changed', () => {
    expect(prefixChanges(a, stepPrefixHashes(body([{ name: 'u' }], [{ text: 'base' }, { text: 'files' }])))).toEqual([
      'tools',
    ]);
  });

  it('names the exact system block that changed, and a block that appeared', () => {
    const next = stepPrefixHashes(body([{ name: 't' }], [{ text: 'base' }, { text: 'files v2' }, { text: 'new' }]));

    expect(prefixChanges(a, next)).toEqual(['system[1]', 'system[2]']);
  });

  it('says nothing when either side is unknown', () => {
    expect(prefixChanges(undefined, a)).toEqual([]);
    expect(prefixChanges(a, undefined)).toEqual([]);
  });
});
